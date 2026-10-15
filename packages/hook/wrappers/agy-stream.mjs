#!/usr/bin/env node
import { spawn } from 'node:child_process';
import readline from 'node:readline';

function sendHook(ev, payload) {
  try {
    const c = spawn('emberline-hook', [ev], { stdio: ['pipe', 'ignore', 'ignore'] });
    c.stdin.write(JSON.stringify(payload));
    c.stdin.end();
    c.unref();
  } catch {
    // ignore hook telemetry errors
  }
}

function summarize(p) {
  if (!p || typeof p !== 'object') return '';
  for (const k of ['CommandLine', 'TargetFile', 'AbsolutePath', 'Query', 'Pattern', 'SearchPath', 'Url']) {
    if (typeof p[k] === 'string' && p[k]) return p[k].slice(0, 120);
  }
  return Object.keys(p).length ? JSON.stringify(p).slice(0, 120) : '';
}

console.log('\x1b[1;36m🚀 Google Antigravity CLI (agy) — Starting Agent...\x1b[0m');
let last = Date.now();
let stepAt = Date.now();

const t = setInterval(() => {
  if (Date.now() - last >= 8000) {
    console.log(
      `\x1b[0;90m💭 Reasoning / executing step... (${Math.round((Date.now() - stepAt) / 1000)}s elapsed)\x1b[0m`,
    );
  }
}, 8000);
t.unref();

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  last = Date.now();
  const s = line.trim();
  if (!s) return;
  if (!s.startsWith('{')) {
    console.log(line);
    return;
  }
  try {
    const o = JSON.parse(s);
    if (o.event === 'init') {
      stepAt = Date.now();
      console.log(`\x1b[0;36m✓ Session ${(o.conversation_id || '').slice(0, 8)} connected\x1b[0m`);
    } else if (o.event === 'step_update' && o.step_update) {
      const su = o.step_update;
      if (su.step_type === 'tool') {
        const tn = su.tool_name || su.tool_info?.name || 'tool';
        const sum = summarize(su.tool_info?.parameters);
        if (su.state === 'ACTIVE') {
          stepAt = Date.now();
          console.log(`\x1b[1;34m🔧 [${tn}]\x1b[0m ${sum}`);
          sendHook('PreToolUse', {
            tool_name: tn,
            tool_input: su.tool_info?.parameters || {},
            message: sum ? `${tn}: ${sum}` : tn,
          });
        } else if (su.state === 'DONE') {
          stepAt = Date.now();
          console.log(
            `\x1b[0;32m  ✓ ${tn}${typeof su.duration_seconds === 'number' ? ` (${su.duration_seconds.toFixed(2)}s)` : ''}\x1b[0m`,
          );
          sendHook('PostToolUse', {
            tool_name: tn,
            message: sum ? `${tn}: ${sum}` : tn,
          });
        }
      } else if (su.step_type === 'agent_response') {
        if (su.text_delta) process.stdout.write(su.text_delta);
        if (su.state === 'DONE') {
          stepAt = Date.now();
          if (su.usage?.thinking_tokens && !su.text_delta) {
            console.log(`\x1b[0;90m  💭 Thought (${su.usage.thinking_tokens} tokens)\x1b[0m`);
          }
        }
      }
    } else if (o.event === 'result' && o.result) {
      console.log(`\n\x1b[1;32m✨ Turn ${o.result.status || 'DONE'}\x1b[0m`);
    }
  } catch {
    console.log(line);
  }
});
