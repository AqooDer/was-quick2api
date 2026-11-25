import test from 'node:test';
import assert from 'node:assert/strict';
import { byteLength } from '../src/util.mjs';
import {
  buildToolBridgePrompt,
  formatTranscript,
  groupToolDefinitions,
  limitToolCalls,
  buildResumeReminder,
  neutralizeSystemPrompt,
  normalizeMessages,
  normalizeTools,
  parseClientToolCalls,
  parseToolChoice,
  planTurns,
  resolveToolName,
  splitSystemMessages,
  RELAY_CONTRACT,
  systemText,
} from '../src/translate.mjs';

const tools = normalizeTools([
  {
    name: 'Bash',
    description: 'Run a shell command',
    input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
]);

test('system text normalizes string and blocks', () => {
  assert.equal(systemText('you are helpful'), 'you are helpful');
  assert.equal(systemText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\n\nb');
});

test('transcript renders tool calls and results with names', () => {
  const messages = normalizeMessages([
    { role: 'user', content: 'read it' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'calling' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a.txt' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] },
  ]);
  const text = formatTranscript(messages);
  assert.match(text, /Assistant: calling/);
  assert.match(text, /Assistant tool call \(id=t1, name=Read\): \{"path":"a.txt"\}/);
  assert.match(text, /Tool result \(call_id=t1, name=Read\): file body/);
});

test('a single user message passes through without a role prefix', () => {
  const text = formatTranscript(normalizeMessages([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]));
  assert.equal(text, 'hello');
});

test('planTurns keeps small payloads in one turn', () => {
  const turns = planTurns({ instructions: 'system', transcript: 'hello', maxBytes: 63488, chunkBytes: 49152 });
  assert.equal(turns.length, 1);
  assert.match(turns[0], /^\[System instructions from the API caller\]/);
  assert.match(turns[0], /hello$/);
});

test('planTurns splits oversized instructions into setup turns', () => {
  const instructions = `HEAD\n${'x'.repeat(120_000)}\nTAIL`;
  const turns = planTurns({ instructions, transcript: 'do the thing', maxBytes: 63_488, chunkBytes: 49_152 });
  assert.ok(turns.length >= 3, `expected priming turns, got ${turns.length}`);
  for (const turn of turns) assert.ok(byteLength(turn) <= 63_488, `turn too large: ${byteLength(turn)}`);
  assert.match(turns[0], /setup only/);
  assert.match(turns.at(-1), /do the thing/);
  assert.match(turns.at(-1), /provided in the setup turns above/);
});

test('planTurns splits an oversized transcript', () => {
  const turns = planTurns({ instructions: '', transcript: 'y'.repeat(100_000), maxBytes: 63_488, chunkBytes: 49_152 });
  assert.ok(turns.length >= 2);
  for (const turn of turns) assert.ok(byteLength(turn) <= 63_488);
  assert.match(turns.at(-1), /answer the complete message now|answer it now/i);
});

test('tool bridge includes the schema and protocol', () => {
  const prompt = buildToolBridgePrompt(tools, parseToolChoice({ type: 'auto' }));
  assert.match(prompt, /<caller_tool_interface>/);
  assert.match(prompt, /"name":"Bash"/);
  assert.match(prompt, /<client_tool_call>/);
});

test('parses tagged, fenced, bare and namespaced tool calls', () => {
  const allowed = new Set(['Bash', 'Read']);
  assert.deepEqual(
    parseClientToolCalls('<client_tool_call>{"name":"Bash","arguments":{"command":"ls"}}</client_tool_call>', allowed).calls.map((c) => c.name),
    ['Bash'],
  );
  assert.deepEqual(
    parseClientToolCalls('```\n{"name":"functions.Read","arguments":{"path":"a"}}\n```', allowed).calls.map((c) => c.name),
    ['Read'],
  );
  assert.deepEqual(
    parseClientToolCalls('{"tool_calls":[{"function":{"name":"Bash","arguments":"{\\"command\\":\\"pwd\\"}"}}]}', allowed).calls.map((c) => c.name),
    ['Bash'],
  );
  const mixed = parseClientToolCalls('before <tool_call>{"name":"Read","parameters":{"path":"x"}}</tool_call> after', allowed);
  assert.equal(mixed.text, 'before  after');
  assert.equal(mixed.calls[0].arguments, '{"path":"x"}');
});

test('unknown tool names are left as plain text', () => {
  const result = parseClientToolCalls('<client_tool_call>{"name":"Nope","arguments":{}}</client_tool_call>', new Set(['Bash']));
  assert.equal(result.calls.length, 0);
  assert.match(result.text, /<client_tool_call>/);
});

test('tool choice limits parallel calls and names', () => {
  const calls = [
    { id: '1', name: 'Bash', arguments: '{}' },
    { id: '2', name: 'Read', arguments: '{}' },
  ];
  assert.equal(limitToolCalls(calls, { mode: 'auto', parallel: false }).length, 1);
  assert.deepEqual(limitToolCalls(calls, { mode: 'tool', name: 'Read', parallel: true }).map((c) => c.name), ['Read']);
  assert.equal(limitToolCalls(calls, { mode: 'none', parallel: true }).length, 0);
});

test('resolveToolName tolerates prefixes and case', () => {
  const allowed = new Set(['Bash', 'mcp__fs__read']);
  assert.equal(resolveToolName('functions.bash', allowed), 'Bash');
  assert.equal(resolveToolName('MCP__FS__READ', allowed), 'mcp__fs__read');
  assert.equal(resolveToolName('fs__read', allowed), '');
});

test('groupToolDefinitions emits valid JSON groups under the budget', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    name: `Tool${i}`,
    description: `d${i}`.repeat(2000),
    parameters: { type: 'object', properties: { x: { type: 'string' } } },
  }));
  const groups = groupToolDefinitions(many, 20_000);
  assert.ok(groups.length > 1);
  for (const group of groups) {
    const json = JSON.stringify({ tools: group });
    assert.ok(byteLength(json) <= 20_000 || group.length === 1);
    assert.equal(JSON.parse(json).tools.length, group.length);
  }
  assert.equal(groups.flat().length, many.length);
});

test('planTurns sends instruction parts as complete setup turns', () => {
  const parts = [
    { title: 'system instructions', text: 'SYSTEM PART' },
    { title: 'caller tool definitions', text: 'Caller tool definitions, forwarded verbatim:\n{"tools":[]}' },
  ];
  const finalPrefix = '[System instructions from the API caller were provided in the setup turns above.]\n\n<caller_tool_interface>rules</caller_tool_interface>\n\n[User message]\n';
  const turns = planTurns({
    instructions: `SYSTEM PART\n\n${'x'.repeat(90_000)}`,
    transcript: 'do work',
    parts,
    finalPrefix,
    maxBytes: 40_000,
    chunkBytes: 20_000,
  });
  assert.ok(turns.length >= 3);
  assert.match(turns[0], /system instructions/);
  assert.match(turns[1], /caller tool definitions/);
  assert.match(turns.at(-1), /rules/);
  assert.match(turns.at(-1), /do work/);
  for (const turn of turns) assert.ok(byteLength(turn) <= 40_000);
});

test('system/developer messages are promoted to instructions', () => {
  const split = splitSystemMessages([
    { role: 'system', content: 'SYS ONE' },
    { role: 'user', content: 'hello' },
    { role: 'developer', content: [{ type: 'text', text: 'SYS TWO' }] },
    { role: 'assistant', content: 'hi' },
  ]);
  assert.equal(split.system, 'SYS ONE\n\nSYS TWO');
  assert.deepEqual(split.messages.map((m) => m.role), ['user', 'assistant']);
});

test('system identity is neutralized for the upstream agent', () => {
  const neutral = neutralizeSystemPrompt("You are a Claude agent, built on Anthropic's Claude Agent SDK.\nFollow the rules.");
  assert.doesNotMatch(neutral, /built on Anthropic's Claude Agent SDK/);
  assert.match(neutral, /model serving this coding-agent session/);
  assert.match(RELAY_CONTRACT, /<client_tool_call>/);
});

test('resume reminder restates the tool contract', () => {
  const reminder = buildResumeReminder([{ name: 'Bash' }, { name: 'Read' }]);
  assert.match(reminder, /client runs on the caller's machine/);
  assert.match(reminder, /<client_tool_call>/);
  assert.match(reminder, /Bash, Read/);
});
