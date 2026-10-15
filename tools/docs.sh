#!/usr/bin/env bash
# usage: docs.sh <method> '<params-json>'
curl -s -m 60 -X POST https://mcp.sandbox.airwallex.com/docs -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
 -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-{\}}}" | sed -n 's/^data: //p'
