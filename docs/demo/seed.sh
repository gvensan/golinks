#!/bin/bash
# Start a throwaway Golinks instance with demo data (popular public sites) for recording.
# Usage: docs/demo/seed.sh [port]   then: node --experimental-websocket docs/demo/record.mjs http://localhost:PORT /tmp/golinks-demo
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${1:-7790}"
HOME_DIR="$(mktemp -d /tmp/golinks-demo-home.XXXX)"
LINKS_HOME="$HOME_DIR" LINKS_PORT="$PORT" node "$ROOT/server.js" > "$HOME_DIR/server.log" 2>&1 &
echo $! > "$HOME_DIR/server.pid"
sleep 1.5
B="http://localhost:$PORT"; J='content-type: application/json'
add() { curl -s -o /dev/null -X POST "$B/api/links" -H "$J" -d "$1"; }
for p in "Dev/Docs" "Dev/Repos" "Dev/Tools" "Reading" "Learning/Courses" "Design"; do curl -s -o /dev/null -X POST "$B/api/folders" -H "$J" -d "{\"path\":\"$p\"}"; done
add '{"url":"https://developer.mozilla.org/en-US/docs/Web/JavaScript","title":"JavaScript | MDN Web Docs","description":"The definitive reference for JavaScript: language guide, built-in objects, and browser APIs, with examples for every feature.","tags":["docs","javascript","reference"],"keyword":"js","folder":"Dev/Docs","enrich":false,"snapshotMode":"auto","applyRules":false}'
add '{"url":"https://react.dev/learn","title":"Quick Start - React","description":"Learn React from the official docs: components, props, state, and the thinking-in-React tutorial.","tags":["docs","react","frontend"],"keyword":"react","folder":"Dev/Docs","enrich":false,"snapshotMode":"auto","applyRules":false}'
add '{"url":"https://docs.python.org/3/","title":"Python 3 documentation","description":"Tutorial, library reference and language reference for Python 3.","tags":["docs","python"],"keyword":"py","folder":"Dev/Docs","enrich":false,"snapshotMode":"auto","applyRules":false}'
add '{"url":"https://kubernetes.io/docs/home/","title":"Kubernetes Documentation","description":"Concepts, tasks and tutorials for running containerized workloads on Kubernetes.","tags":["docs","kubernetes","devops"],"keyword":"k8s","folder":"Dev/Docs","enrich":false,"snapshotMode":"auto","applyRules":false}'
add '{"url":"https://github.com/nodejs/node","title":"nodejs/node: Node.js JavaScript runtime","description":"The Node.js repository: issues, pull requests and releases.","tags":["github","nodejs"],"keyword":"node","folder":"Dev/Repos","enrich":false,"snapshotMode":"auto","applyRules":false}'
add '{"url":"https://github.com/microsoft/vscode","title":"microsoft/vscode: Visual Studio Code","description":"Source code and issue tracker for VS Code.","tags":["github","editor"],"keyword":"vscode","folder":"Dev/Repos","enrich":false,"snapshotMode":"auto","applyRules":false}'
add '{"url":"https://regex101.com/","title":"regex101: build, test, and debug regex","description":"Online regex tester with explanation, match highlighting and a cheat sheet.","tags":["tool","regex"],"keyword":"regex","folder":"Dev/Tools","enrich":false,"snapshotMode":"auto","applyRules":false}'
add '{"url":"https://www.notion.so/help","title":"Notion Help Center","description":"Guides and reference for Notion pages, databases and integrations.","tags":["tool","notes"],"folder":"Dev/Tools","enrich":false,"snapshotMode":"auto","applyRules":false}'
add '{"url":"https://excalidraw.com/","title":"Excalidraw","description":"Virtual whiteboard for sketching hand-drawn like diagrams.","tags":["tool","diagrams"],"keyword":"draw","folder":"Design","enrich":false,"snapshotMode":"auto","applyRules":false}'
add '{"url":"https://www.figma.com/community","title":"Figma Community","description":"Free templates, plugins and UI kits shared by the Figma community.","tags":["design","figma"],"folder":"Design","enrich":false,"snapshotMode":"auto","applyRules":false}'
add '{"url":"https://news.ycombinator.com/","title":"Hacker News","description":"Tech and startup news with discussion, from Y Combinator.","tags":["news","tech"],"keyword":"hn","folder":"Reading","enrich":false,"snapshotMode":"auto","applyRules":false}'
add '{"url":"https://en.wikipedia.org/wiki/Event-driven_architecture","title":"Event-driven architecture - Wikipedia","description":"Software architecture paradigm concerning the production and consumption of events.","tags":["architecture","reference"],"folder":"Reading","enrich":false,"snapshotMode":"auto","applyRules":false}'
add '{"url":"https://www.coursera.org/learn/machine-learning","title":"Machine Learning Specialization - Coursera","description":"Introductory machine learning course: supervised learning, neural networks, and practical advice.","tags":["course","ml"],"folder":"Learning/Courses","enrich":false,"snapshotMode":"auto","applyRules":false}'
add '{"url":"https://www.youtube.com/@Fireship","title":"Fireship - YouTube","description":"High-intensity code tutorials and tech news in 100 seconds.","tags":["video","learning"],"keyword":"fireship","folder":"Learning","enrich":false,"snapshotMode":"auto","applyRules":false}'
curl -s -o /dev/null -X PUT "$B/api/templates" -H "$J" -d '{"templates":{"gh":"https://github.com/{0}","npm":"https://www.npmjs.com/package/{0}","mdn":"https://developer.mozilla.org/en-US/search?q={q}","g":"https://www.google.com/search?q={q}"}}'
curl -s -o /dev/null -X PUT "$B/api/settings" -H "$J" -d '{"setup":{"go":true,"bookmarklet":true,"permissions":true,"seen":true}}'
for k in js react node hn js react js; do curl -s -o /dev/null --max-redirs 0 "$B/go/$k"; done
echo "demo instance on $B, data in $HOME_DIR (pid $(cat "$HOME_DIR/server.pid")). Wait for snapshots, then record:"
echo "  node --experimental-websocket $ROOT/docs/demo/record.mjs $B /tmp/golinks-demo-out"
echo "  ffmpeg -f concat -safe 0 -i /tmp/golinks-demo-out/frames.txt -vf fps=12,format=yuv420p -c:v libx264 -crf 23 -movflags +faststart docs/demo.mp4"
