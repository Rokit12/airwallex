/**
 * Run the test storefront on its own so an AI assistant can use its MCP tools:
 *
 *   npm run store
 *   then add http://localhost:4320/mcp to it as an HTTP MCP server
 *
 * Then ask the assistant, e.g. "find me a set of insulated water bottles under $85 with returns".
 */
import "../core/env.ts";
import { RailsClient } from "../core/rails.ts";
import { startStore } from "./server.ts";

const { url } = await startStore(new RailsClient(), Number(process.env.STORE_PORT ?? 4320));
console.log(`Trailhead Outfitters store → ${url}\nMCP endpoint → ${url}/mcp`);
