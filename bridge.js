/**
 * MCP HTTP Bridge
 * 
 * A lightweight HTTP bridge for Model Context Protocol (MCP) servers.
 * Allows AI applications to communicate with MCP servers via REST API.
 * 
 * Features:
 * - Manages multiple MCP server processes via Docker containers
 * - JSON-RPC over HTTP for tool discovery and execution
 * - Process lifecycle management with auto-restart
 * - Buffer overflow protection
 * - Request timeout handling
 * - Graceful shutdown
 * 
 * @author Stavion Colquitt
 * @license MIT
 * @version 1.0.0
 */

const express = require('express');
const { spawn } = require('child_process');

const app = express();

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  port: parseInt(process.env.PORT || '3000', 10),
  
  // Buffer limits
  maxBufferSize: parseInt(process.env.MAX_BUFFER_SIZE || '1048576', 10), // 1MB default
  
  // Timeouts
  defaultTimeout: parseInt(process.env.DEFAULT_TIMEOUT || '30000', 10),
  startupTimeout: parseInt(process.env.STARTUP_TIMEOUT || '30000', 10),
  
  // Process management
  maxRestarts: parseInt(process.env.MAX_RESTARTS || '5', 10),
  restartWindowMs: parseInt(process.env.RESTART_WINDOW_MS || '300000', 10), // 5 minutes
  
  // Fetch queue (optional rate limiting for fetch-type servers)
  fetchQueue: {
    enabled: process.env.FETCH_QUEUE_ENABLED === 'true',
    maxConcurrent: parseInt(process.env.FETCH_MAX_CONCURRENT || '5', 10),
    maxQueueSize: parseInt(process.env.FETCH_MAX_QUEUE || '20', 10),
    requestTimeout: parseInt(process.env.FETCH_TIMEOUT || '30000', 10)
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// MCP SERVER DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Define your MCP servers here.
 * Each server needs:
 * - container: Docker container name
 * - command: Array of command + args to execute inside container
 * 
 * Example configurations for common MCP servers are provided below.
 * Modify or add servers based on your setup.
 */
const MCP_SERVERS = {
  // Example: Filesystem MCP server
  'filesystem': {
    container: 'filesystem-mcp',
    command: ['docker', 'exec', '-i', 'filesystem-mcp', 'npx', '-y', 
              '@modelcontextprotocol/server-filesystem', '/data']
  },
  
  // Example: Fetch MCP server (web fetching)
  'fetch': {
    container: 'fetch-mcp',
    command: ['docker', 'exec', '-i', 'fetch-mcp', 'mcp-fetch-server']
  },
  
  // Example: Browser automation (Playwright/Chrome DevTools)
  'browser': {
    container: 'browser-mcp',
    command: ['docker', 'exec', '-i', 'browser-mcp', 'node', '/app/build/index.js']
  }
  
  // Add more servers as needed:
  // 'your-server': {
  //   container: 'your-container-name',
  //   command: ['docker', 'exec', '-i', 'your-container-name', 'node', '/app/index.js']
  // }
};

// Allow loading additional servers from environment variable (JSON format)
if (process.env.MCP_SERVERS_CONFIG) {
  try {
    const additionalServers = JSON.parse(process.env.MCP_SERVERS_CONFIG);
    Object.assign(MCP_SERVERS, additionalServers);
    console.log(`[CONFIG] Loaded ${Object.keys(additionalServers).length} additional servers from environment`);
  } catch (e) {
    console.error('[CONFIG] Failed to parse MCP_SERVERS_CONFIG:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPRESS MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════

// JSON parser with error handling
app.use(express.json({
  strict: false,
  limit: '10mb',
  verify: (req, res, buf, encoding) => {
    try {
      req.rawBody = buf.toString(encoding || 'utf8');
    } catch (err) {
      console.error('Error storing raw body:', err);
    }
  }
}));

// Fallback text parser
app.use(express.text({ type: '*/*', limit: '10mb' }));

// JSON parse error handler
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('JSON Parse Error:', err.message);
    return res.status(400).json({
      error: 'Invalid JSON',
      message: err.message,
      hint: 'Check for unescaped special characters in your JSON'
    });
  }
  next(err);
});

// ═══════════════════════════════════════════════════════════════════════════
// PROCESS MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

const mcpProcesses = new Map();

/**
 * Spawn a process with startup timeout protection
 */
function spawnWithTimeout(command, args, options, timeoutMs = CONFIG.startupTimeout) {
  const proc = spawn(command, args, options);
  
  const startupTimeout = setTimeout(() => {
    if (!proc.killed) {
      console.error(`[SPAWN] Process startup timeout after ${timeoutMs}ms: ${command}`);
      proc.kill('SIGKILL');
    }
  }, timeoutMs);
  
  // Clear timeout once we get any output (process is alive)
  proc.stdout.once('data', () => clearTimeout(startupTimeout));
  proc.stderr.once('data', () => clearTimeout(startupTimeout));
  proc.on('exit', () => clearTimeout(startupTimeout));
  proc.on('error', () => clearTimeout(startupTimeout));
  
  return proc;
}

/**
 * Get or create an MCP server process
 */
function getMCPProcess(serverName) {
  if (!MCP_SERVERS[serverName]) {
    throw new Error(`Unknown server: ${serverName}`);
  }
  
  let processInfo = mcpProcesses.get(serverName);
  
  // Check if process exists and is still alive
  if (processInfo && processInfo.process && !processInfo.process.killed) {
    return processInfo;
  }
  
  // Start new process
  const config = MCP_SERVERS[serverName];
  console.log(`[${serverName}] Starting: ${config.command.join(' ')}`);
  
  const process = spawnWithTimeout(config.command[0], config.command.slice(1), {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  
  processInfo = {
    process,
    name: serverName,
    buffer: '',
    pendingRequests: new Map(),
    requestId: 0,
    initialized: false,
    lastError: null,
    restartCount: 0,
    lastRestart: null
  };
  
  // Handle stdout with buffer overflow protection
  process.stdout.on('data', (data) => {
    const newData = data.toString();
    
    // Check buffer size limit
    if (processInfo.buffer.length + newData.length > CONFIG.maxBufferSize) {
      console.error(`[${serverName}] Buffer overflow - clearing (was ${processInfo.buffer.length} bytes)`);
      processInfo.lastError = 'Buffer overflow - response too large';
      
      // Reject all pending requests
      for (const [id, { reject }] of processInfo.pendingRequests) {
        const err = new Error('Response too large (buffer overflow)');
        err.code = 'BUFFER_OVERFLOW';
        err.server = serverName;
        reject(err);
      }
      processInfo.pendingRequests.clear();
      processInfo.buffer = '';
      processInfo.initialized = false;
      
      // Kill process to recover
      if (!processInfo.process.killed) {
        processInfo.process.kill('SIGTERM');
      }
      return;
    }
    
    processInfo.buffer += newData;
    let lines = processInfo.buffer.split('\n');
    processInfo.buffer = lines.pop() || '';
    
    for (const line of lines) {
      if (line.trim()) {
        try {
          const message = JSON.parse(line);
          
          if (message.id && processInfo.pendingRequests.has(message.id)) {
            const { resolve } = processInfo.pendingRequests.get(message.id);
            processInfo.pendingRequests.delete(message.id);
            resolve(message);
          }
        } catch (e) {
          console.error(`[${serverName}] Failed to parse JSON:`, line.substring(0, 200));
        }
      }
    }
  });
  
  // Handle stderr
  process.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) {
      console.log(`[${serverName}] stderr: ${msg}`);
      processInfo.lastError = msg;
    }
  });
  
  // Handle process exit with auto-restart
  process.on('exit', (code) => {
    console.log(`[${serverName}] Process exited with code ${code}`);
    processInfo.initialized = false;
    
    // Reject all pending requests
    for (const [id, { reject }] of processInfo.pendingRequests) {
      const err = new Error(`Process exited with code ${code}`);
      err.code = 'PROCESS_EXIT';
      err.server = serverName;
      reject(err);
    }
    processInfo.pendingRequests.clear();
    
    // Auto-restart with exponential backoff
    const now = Date.now();
    if (!processInfo.lastRestart || (now - processInfo.lastRestart) > CONFIG.restartWindowMs) {
      processInfo.restartCount = 0;
    }
    
    if (processInfo.restartCount < CONFIG.maxRestarts && code !== 0) {
      processInfo.restartCount++;
      processInfo.lastRestart = now;
      const delay = Math.min(1000 * Math.pow(2, processInfo.restartCount - 1), 30000);
      console.log(`[${serverName}] Restarting in ${delay}ms (attempt ${processInfo.restartCount}/${CONFIG.maxRestarts})`);
      
      setTimeout(() => {
        mcpProcesses.delete(serverName);
        try {
          getMCPProcess(serverName);
        } catch (e) {
          console.error(`[${serverName}] Failed to restart:`, e.message);
        }
      }, delay);
    } else {
      mcpProcesses.delete(serverName);
    }
  });
  
  // Handle spawn errors
  process.on('error', (error) => {
    console.error(`[${serverName}] Process spawn error:`, error);
    processInfo.lastError = error.message;
    processInfo.initialized = false;
    
    for (const [id, { reject }] of processInfo.pendingRequests) {
      const err = new Error(`Process error: ${error.message}`);
      err.code = 'PROCESS_ERROR';
      err.server = serverName;
      reject(err);
    }
    processInfo.pendingRequests.clear();
    mcpProcesses.delete(serverName);
  });
  
  mcpProcesses.set(serverName, processInfo);
  return processInfo;
}

/**
 * Send a JSON-RPC request to an MCP server
 */
async function sendMCPRequest(serverName, method, params = {}, timeout = CONFIG.defaultTimeout) {
  const serverState = getMCPProcess(serverName);
  
  if (!serverState || !serverState.process || serverState.process.killed) {
    throw new Error(`Server ${serverName} is not running`);
  }
  
  const id = ++serverState.requestId;
  const request = {
    jsonrpc: '2.0',
    id,
    method,
    params
  };
  
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      serverState.pendingRequests.delete(id);
      reject(new Error(`Request timeout after ${timeout}ms`));
    }, timeout);
    
    serverState.pendingRequests.set(id, {
      resolve: (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      }
    });
    
    const requestStr = JSON.stringify(request) + '\n';
    
    try {
      const writeSuccess = serverState.process.stdin.write(requestStr, (err) => {
        if (err) {
          clearTimeout(timer);
          serverState.pendingRequests.delete(id);
          reject(new Error(`Write failed: ${err.message}`));
        }
      });
      
      if (!writeSuccess) {
        console.warn(`[${serverName}] Write backpressure - stdin buffer full`);
      }
    } catch (writeError) {
      clearTimeout(timer);
      serverState.pendingRequests.delete(id);
      reject(new Error(`Write exception: ${writeError.message}`));
    }
  });
}

/**
 * Initialize an MCP server (required before making tool calls)
 */
async function initializeServer(serverName) {
  const serverState = getMCPProcess(serverName);
  
  if (serverState.initialized) {
    return true;
  }
  
  const response = await sendMCPRequest(serverName, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-http-bridge', version: '1.0.0' }
  });
  
  if (response.error) {
    throw new Error(response.error.message || 'Initialization failed');
  }
  
  serverState.initialized = true;
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// OPTIONAL: FETCH QUEUE (Rate limiting for web fetch operations)
// ═══════════════════════════════════════════════════════════════════════════

const fetchQueue = {
  active: 0,
  pending: [],
  stats: { totalProcessed: 0, totalQueued: 0 }
};

function processFetchQueue() {
  while (fetchQueue.active < CONFIG.fetchQueue.maxConcurrent && fetchQueue.pending.length > 0) {
    const next = fetchQueue.pending.shift();
    if (next && !next.timedOut) {
      fetchQueue.active++;
      next.resolve();
    }
  }
}

function enqueueFetchRequest() {
  return new Promise((resolve, reject) => {
    if (fetchQueue.active < CONFIG.fetchQueue.maxConcurrent) {
      fetchQueue.active++;
      resolve();
      return;
    }
    
    if (fetchQueue.pending.length >= CONFIG.fetchQueue.maxQueueSize) {
      reject(new Error(`Queue full (${CONFIG.fetchQueue.maxQueueSize} pending)`));
      return;
    }
    
    fetchQueue.stats.totalQueued++;
    const queueItem = { resolve, reject, timedOut: false };
    fetchQueue.pending.push(queueItem);
    
    setTimeout(() => {
      queueItem.timedOut = true;
      const idx = fetchQueue.pending.indexOf(queueItem);
      if (idx > -1) {
        fetchQueue.pending.splice(idx, 1);
        reject(new Error('Request timed out in queue'));
      }
    }, CONFIG.fetchQueue.requestTimeout);
  });
}

function releaseFetchSlot() {
  if (fetchQueue.active > 0) {
    fetchQueue.active--;
    fetchQueue.stats.totalProcessed++;
  }
  processFetchQueue();
}

// ═══════════════════════════════════════════════════════════════════════════
// API ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Health check - returns status of all configured servers
 */
app.get('/health', async (req, res) => {
  const results = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    servers: {}
  };
  
  for (const [name] of Object.entries(MCP_SERVERS)) {
    try {
      await initializeServer(name);
      const toolsResponse = await sendMCPRequest(name, 'tools/list', {}, 5000);
      
      results.servers[name] = {
        status: 'healthy',
        toolCount: toolsResponse.result?.tools?.length || 0
      };
    } catch (error) {
      results.servers[name] = {
        status: 'error',
        error: error.message
      };
    }
  }
  
  res.json(results);
});

/**
 * List all available tools from all servers
 */
app.get('/tools', async (req, res) => {
  const allTools = [];
  
  for (const serverName of Object.keys(MCP_SERVERS)) {
    try {
      await initializeServer(serverName);
      const response = await sendMCPRequest(serverName, 'tools/list', {}, 10000);
      
      if (response.result?.tools) {
        for (const tool of response.result.tools) {
          allTools.push({
            ...tool,
            serverName
          });
        }
      }
    } catch (error) {
      console.error(`Failed to get tools from ${serverName}:`, error.message);
    }
  }
  
  res.json({ tools: allTools, count: allTools.length });
});

/**
 * List tools from a specific server
 */
app.get('/tools/:serverName', async (req, res) => {
  try {
    const { serverName } = req.params;
    
    if (!MCP_SERVERS[serverName]) {
      return res.status(404).json({ error: 'Server not found' });
    }
    
    await initializeServer(serverName);
    const response = await sendMCPRequest(serverName, 'tools/list');
    
    res.json(response.result || { tools: [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Call a tool on a specific server
 * 
 * POST /call
 * Body: { server: string, tool: string, arguments: object }
 */
app.post('/call', async (req, res) => {
  const { server, tool, arguments: toolArgs } = req.body || {};
  
  if (!server || !tool) {
    return res.status(400).json({ error: 'Missing server or tool parameter' });
  }
  
  if (!MCP_SERVERS[server]) {
    return res.status(404).json({ error: 'Server not found' });
  }
  
  // Optional: Apply fetch queue rate limiting
  const useFetchQueue = CONFIG.fetchQueue.enabled && server === 'fetch';
  
  if (useFetchQueue) {
    try {
      await enqueueFetchRequest();
    } catch (queueError) {
      return res.status(429).json({
        error: 'Server busy',
        message: queueError.message
      });
    }
  }
  
  try {
    await initializeServer(server);
    
    const response = await sendMCPRequest(server, 'tools/call', {
      name: tool,
      arguments: toolArgs || {}
    });
    
    res.json(response.result || {});
    
  } catch (error) {
    console.error(`[${server}] Tool call failed:`, error.message);
    res.status(500).json({
      error: error.message,
      server,
      tool
    });
  } finally {
    if (useFetchQueue) {
      releaseFetchSlot();
    }
  }
});

/**
 * List configured servers
 */
app.get('/servers', (req, res) => {
  const servers = Object.entries(MCP_SERVERS).map(([name, config]) => ({
    name,
    container: config.container
  }));
  
  res.json({ servers, count: servers.length });
});

// ═══════════════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════════

let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log(`\n[BRIDGE] Received ${signal}, shutting down gracefully...`);
  
  // Kill all MCP child processes
  for (const [serverName, processInfo] of mcpProcesses) {
    if (processInfo.process && !processInfo.process.killed) {
      console.log(`[BRIDGE] Stopping ${serverName}...`);
      processInfo.process.kill('SIGTERM');
    }
  }
  
  // Give processes time to exit gracefully
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Force kill any remaining
  for (const [serverName, processInfo] of mcpProcesses) {
    if (processInfo.process && !processInfo.process.killed) {
      console.log(`[BRIDGE] Force killing ${serverName}...`);
      processInfo.process.kill('SIGKILL');
    }
  }
  
  console.log('[BRIDGE] Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (error) => {
  console.error('[BRIDGE] Uncaught exception:', error);
  gracefulShutdown('uncaughtException');
});

// ═══════════════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════════════

if (isNaN(CONFIG.port) || CONFIG.port < 1 || CONFIG.port > 65535) {
  console.error('Invalid PORT environment variable');
  process.exit(1);
}

app.listen(CONFIG.port, '0.0.0.0', () => {
  console.log(`🌉 MCP HTTP Bridge v1.0.0`);
  console.log(`📡 Listening on http://0.0.0.0:${CONFIG.port}`);
  console.log(`🔧 Configured servers: ${Object.keys(MCP_SERVERS).join(', ')}`);
});
