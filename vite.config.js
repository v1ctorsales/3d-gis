import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { Buffer } from 'node:buffer'

// Serves api/overpass.js at /api/overpass during `npm run dev`, so dev hits
// mirrors server-side exactly like the Vercel function does in prod.
function overpassDevProxy() {
  return {
    name: 'overpass-dev-proxy',
    configureServer(server) {
      server.middlewares.use('/api/overpass', async (req, res) => {
        try {
          const { GET, POST } = await server.ssrLoadModule('/api/overpass.js')
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          const request = new Request(`http://localhost${req.originalUrl}`, {
            method: req.method,
            body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
          })
          const handler = req.method === 'POST' ? POST : GET
          const response = await handler(request)
          res.statusCode = response.status
          response.headers.forEach((value, key) => res.setHeader(key, value))
          res.end(Buffer.from(await response.arrayBuffer()))
        } catch (err) {
          res.statusCode = 500
          res.end(String(err?.stack || err))
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), overpassDevProxy()],
})
