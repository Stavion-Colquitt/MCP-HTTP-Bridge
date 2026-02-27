[README.md](https://github.com/user-attachments/files/24375880/README.md)
# MCP HTTP Bridge

🌉 A lightweight HTTP bridge for [Model Context Protocol (MCP)](https://modelcontextprotocol.io) servers.

Turn your MCP servers into REST APIs! This bridge allows any HTTP client to discover and call tools on MCP servers running in Docker containers.

## Features

- **REST API** - Simple HTTP endpoints for tool discovery and execution
- **Multi-server** - Manage multiple MCP servers from one bridge
- **Docker integration** - Communicate with MCP servers via `docker exec`
- **Auto-restart** - Crashed processes restart automatically with exponential backoff
- **Buffer protection** - Prevents memory exhaustion from large responses
- **Graceful shutdown** - Clean process termination on exit
- **Rate limiting** - Optional request queue for high-traffic servers

## Quick Start

### Prerequisites

- Node.js 18+
- Docker
- MCP servers running in Docker containers

### Installation

```bash
git clone https://github.com/Stavion-Colquitt/mcp-http-bridge.git
cd mcp-http-bridge
npm install
```

### Configuration

Edit `bridge.js` to define your MCP servers:

```javascript
const MCP_SERVERS = {
  'filesystem': {
    container: 'filesystem-mcp',
    command: ['docker', 'exec', '-i', 'filesystem-mcp', 'npx', '-y', 
              '@modelcontextprotocol/server-filesystem', '/data']
  },
  'fetch': {
    container: 'fetch-mcp',
    command: ['docker', 'exec', '-i', 'fetch-mcp', 'mcp-fetch-server']
  }
};
```

Or load servers from environment variable:

```bash
export MCP_SERVERS_CONFIG='{"myserver":{"container":"my-mcp","command":["docker","exec","-i","my-mcp","node","/app/index.js"]}}'
```

### Run

```bash
npm start
```

Or with environment variables:

```bash
PORT=3100 npm start
```

## API Endpoints

### Health Check

```
GET /health
```

Returns status of all configured servers.

### List All Tools

```
GET /tools
```

Returns all available tools from all servers.

### List Server Tools

```
GET /tools/:serverName
```

Returns tools from a specific server.

### Call a Tool

```
POST /call
Content-Type: application/json

{
  "server": "filesystem",
  "tool": "read_file",
  "arguments": {
    "path": "/data/example.txt"
  }
}
```

### List Servers

```
GET /servers
```

Returns list of configured servers.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | HTTP port |
| `MAX_BUFFER_SIZE` | 1048576 | Max response buffer (bytes) |
| `DEFAULT_TIMEOUT` | 30000 | Request timeout (ms) |
| `STARTUP_TIMEOUT` | 30000 | Process startup timeout (ms) |
| `MAX_RESTARTS` | 5 | Max auto-restarts per window |
| `RESTART_WINDOW_MS` | 300000 | Restart count window (ms) |
| `FETCH_QUEUE_ENABLED` | false | Enable rate limiting |
| `FETCH_MAX_CONCURRENT` | 5 | Max concurrent fetch requests |
| `FETCH_MAX_QUEUE` | 20 | Max queued fetch requests |
| `MCP_SERVERS_CONFIG` | - | JSON server config (optional) |

## Docker Deployment

### Dockerfile

```dockerfile
FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY bridge.js ./

# Mount Docker socket to communicate with other containers
# docker run -v /var/run/docker.sock:/var/run/docker.sock ...

EXPOSE 3000
CMD ["node", "bridge.js"]
```

### Docker Compose

```yaml
version: '3.8'

services:
  mcp-bridge:
    build: .
    ports:
      - "3100:3000"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - PORT=3000
    restart: unless-stopped
    
  # Example MCP server
  filesystem-mcp:
    image: node:20-alpine
    command: npx -y @modelcontextprotocol/server-filesystem /data
    volumes:
      - ./data:/data
```

## Usage Examples

### Python

```python
import requests

# List tools
response = requests.get('http://localhost:3100/tools')
tools = response.json()['tools']

# Call a tool
response = requests.post('http://localhost:3100/call', json={
    'server': 'filesystem',
    'tool': 'read_file',
    'arguments': {'path': '/data/test.txt'}
})
result = response.json()
```

### JavaScript

```javascript
// List tools
const tools = await fetch('http://localhost:3100/tools').then(r => r.json());

// Call a tool
const result = await fetch('http://localhost:3100/call', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    server: 'filesystem',
    tool: 'read_file',
    arguments: { path: '/data/test.txt' }
  })
}).then(r => r.json());
```

### cURL

```bash
# Health check
curl http://localhost:3100/health

# List tools
curl http://localhost:3100/tools

# Call a tool
curl -X POST http://localhost:3100/call \
  -H "Content-Type: application/json" \
  -d '{"server":"filesystem","tool":"read_file","arguments":{"path":"/data/test.txt"}}'
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    MCP HTTP Bridge                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   HTTP Client (AI App, Script, etc.)                        │
│           │                                                 │
│           ▼                                                 │
│   ┌───────────────────┐                                    │
│   │  Express Server   │  :3000                             │
│   │  - /health        │                                    │
│   │  - /tools         │                                    │
│   │  - /call          │                                    │
│   └─────────┬─────────┘                                    │
│             │                                               │
│             ▼                                               │
│   ┌───────────────────┐                                    │
│   │ Process Manager   │                                    │
│   │ - spawn processes │                                    │
│   │ - JSON-RPC comms  │                                    │
│   │ - auto-restart    │                                    │
│   └─────────┬─────────┘                                    │
│             │                                               │
│     docker exec -i container_name ...                       │
│             │                                               │
│   ┌─────────┴─────────────────────────────────┐            │
│   │              Docker Containers             │            │
│   │  ┌─────────┐ ┌─────────┐ ┌─────────┐     │            │
│   │  │ MCP     │ │ MCP     │ │ MCP     │     │            │
│   │  │ Server 1│ │ Server 2│ │ Server 3│     │            │
│   │  └─────────┘ └─────────┘ └─────────┘     │            │
│   └───────────────────────────────────────────┘            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## How It Works

1. **Startup**: Bridge starts Express server and waits for requests
2. **Tool Discovery**: On first request to a server, spawns `docker exec` process
3. **Initialization**: Sends MCP `initialize` message to establish protocol
4. **Tool Calls**: Converts HTTP requests to JSON-RPC, sends via stdin
5. **Responses**: Parses JSON-RPC responses from stdout, returns as HTTP JSON
6. **Error Handling**: Auto-restarts crashed processes, rejects pending requests

## Contributing

Contributions welcome! Please open an issue or PR.

## License

MIT - see [LICENSE](LICENSE)

## Author

**Stavion Colquitt**

---

*Built for the AI-powered future* 🚀
