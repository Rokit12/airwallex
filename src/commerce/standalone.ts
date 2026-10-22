/**
 * Run the test storefront on its own so Claude can use its MCP tools:
 *
 *   npm run store
 *   claude mcp add-json trailhead-store '{"type":"http","url":"http://localhost:4320/mcp"}'
 *
 * Then ask Claude, e.g. "find me a set of insulated water bottles under $85 with returns".
 */
import "../core/env.ts";
import { RailsClient } from "../core/rails.ts";
import { startStore } from "./server.ts";

const { url } = await startStore(new RailsClient(), Number(process.env.STORE_PORT ?? 4320));
console.log(`Trailhead Outfitters store → ${url}\nMCP endpoint → ${url}/mcp`);
