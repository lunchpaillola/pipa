import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createRuntimeFixture, bounded } from '../../test/helpers/runtime-fixture.mjs';
import { OpenCode } from '@opencode/client';
import { createV2Adapter } from '../../src/opencode-v2.mjs';
import { createPendingInteractions } from '../../src/app.mjs';
import { createProvider, providerConfig } from './opencode-provider.mjs';

const runtime = await createRuntimeFixture({ timeoutMs: 90_000, cleanupTimeoutMs: 10_000 });
const report = { realNativeForms: true, slackTransport: 'captured Block Kit and callbacks, not live Slack', externalProviderUsed: false, cases: [] };
let adapter, controls;
try {
  const provider = await createProvider(runtime);
  await writeFile(runtime.env.OPENCODE_CONFIG, JSON.stringify(providerConfig(provider.url)));
  const server = runtime.spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0', '--log-level', 'error'], {
    env: { ...runtime.env, OPENCODE_PASSWORD: 'isolated-forms', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1', BUN_JSC_maxRegExpStackSize: '536870912' },
  });
  const baseUrl = await bounded(new Promise((resolve, reject) => {
    let output = '';
    server.child.stdout.on('data', chunk => { output += chunk; const match = output.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+/u); if (match) resolve(match[0]); });
    server.exited.then(() => reject(new Error('Native server exited during startup')), reject);
  }), { timeoutMs: 30_000, signal: runtime.signal });
  const headers = { authorization: `Basic ${Buffer.from('opencode:isolated-forms').toString('base64')}` };
  const client = OpenCode.make({ baseUrl, headers });
  const info = await client.server.info({ signal: runtime.signal });
  report.engine = info.version;
  const session = await client.session.create({ location: { directory: runtime.workspace } }, { signal: runtime.signal });
  let card;
  const cards = [];
  const requests = [];
  const attachments = [];
  const checkCard = value => {
    assert.ok(value.blocks.length <= 50, 'Slack message block limit');
    for (const block of value.blocks) {
      if (block.type === 'header') assert.ok(block.text.text.length <= 150);
      if (block.type === 'section') assert.ok(block.text.text.length <= 3000);
      for (const element of block.elements ?? []) {
        if (element.url) assert.ok(element.url.length <= 3000);
        if (element.options) {
          assert.ok(element.options.length <= (['checkboxes', 'radio_buttons'].includes(element.type) ? 10 : 100));
          assert.ok(element.options.every(option => option.text.text.length <= 75));
        }
      }
    }
  };
  const chat = {
    postMessage: async value => { checkCard(value); card = value; cards.push(value); return { ts: '2.0' }; },
    update: async value => { checkCard(value); card = value; cards.push(value); },
    delete: async () => {},
  };
  const thread = { id: 'slack:CTEST:1.0', post: async value => { attachments.push(value); }, adapter: { webClient: { chat } } };
  controls = createPendingInteractions(['UTEST']);
  adapter = createV2Adapter({ baseUrl, headers });
  const controller = new AbortController();
  await adapter.followSession({ sessionId: session.id, workingDirectory: runtime.workspace, controller,
    onInteraction: interaction => { requests.push(interaction); return controls.onInteraction({ thread }, interaction); },
    onResponse: () => {}, onError: error => { throw error; } });
  const actions = () => card.blocks.flatMap(block => block.elements ?? []);
  const click = async (prefix, extra = {}) => {
    const action = actions().find(item => item.action_id?.startsWith(`pipa_${prefix}_`));
    assert.ok(action, `Missing ${prefix} control`);
    await controls.onAction({ actionId: action.action_id, value: action.value, threadId: thread.id, user: { userId: 'UTEST' }, ...extra });
  };
  const text = async value => {
    let modal;
    await click('custom', { openModal: async value => { modal = value; } });
    const result = await controls.onCustomAnswer({ privateMetadata: modal.privateMetadata, relatedThread: thread, user: { userId: 'UTEST' }, values: { answer: value } });
    assert.equal(result?.action, undefined);
  };
  const create = async (fields, extra = {}) => {
    card = undefined;
    const form = await client.session.form.create({ sessionID: session.id, title: 'Native Slack check', fields, ...extra }, { signal: runtime.signal });
    await runtime.waitFor(() => card && requests.some(request => request.request.id === form.id), { timeoutMs: 15_000, label: 'native form reaches Slack' });
    return form;
  };
  const detail = id => client.session.form.get({ sessionID: session.id, formID: id }, { signal: runtime.signal });
  const answered = id => runtime.waitFor(async () => { const value = await detail(id); return value.state.status === 'answered' ? value : false; }, { timeoutMs: 10_000 });
  const form = await create([
    { key: 'hidden', type: 'string', hidden: true, default: 'PRIVATE_DEFAULT' },
    { key: 'name', type: 'string', required: true },
    { key: 'rate', type: 'number', required: true },
    { key: 'count', type: 'integer', required: true },
    { key: 'enabled', type: 'boolean', required: true },
    { key: 'conditional', type: 'string', required: true, when: [{ key: 'enabled', op: 'eq', value: false }] },
    { key: 'tags', type: 'multiselect', options: [{ label: 'Alpha', value: 'native-alpha' }, { label: 'Beta', value: 'native-beta' }], required: true },
    { key: 'external', type: 'external', url: 'https://example.com/action', title: 'Complete the browser step' },
  ]);
  await text('Ada');
  await text('0.5');
  await text('0');
  let selector = actions().find(item => item.type === 'radio_buttons');
  await click('select', { value: selector.options[1].value });
  await click('submit');
  await text('visible after No');
  selector = actions().find(item => item.type === 'checkboxes');
  const block = card.blocks.find(block => block.elements?.includes(selector));
  await click('submit', { raw: { state: { values: { [block.block_id]: { [selector.action_id]: { selected_options: [selector.options[1]] } } } } } });
  await click('external');
  assert.equal((await detail(form.id)).state.status, 'pending', 'A link click must not fabricate completion');
  await click('finished');
  const complete = await answered(form.id);
  assert.deepEqual(complete.state.answer, { hidden: 'PRIVATE_DEFAULT', name: 'Ada', rate: 0.5, count: 0, enabled: false, conditional: 'visible after No', tags: ['native-beta'], external: true });
  assert.ok(cards.every(card => !JSON.stringify(card).includes('PRIVATE_DEFAULT')));
  report.cases.push({ name: 'all-six-types-through-native-form-and-Slack-controls', state: complete.state.status, typedAnswerVerified: true, hiddenDefaultNotPosted: true, linkClickDidNotAcknowledge: true });

  const invalid = await create([{ key: 'limit', type: 'integer', required: true, maximum: 2 }]);
  await text('3');
  assert.equal((await detail(invalid.id)).state.status, 'pending');
  assert.match(JSON.stringify(card), /retry/u);
  await text('2');
  assert.deepEqual((await answered(invalid.id)).state.answer, { limit: 2 });
  report.cases.push({ name: 'native-validation-rejection-remains-editable', invalidRetainedPending: true, correctedAnswerAccepted: true });

  const dismissed = await create([{ key: 'connect', type: 'external', url: 'https://example.com/decline' }]);
  await click('dismiss');
  await runtime.waitFor(async () => (await detail(dismissed.id)).state.status === 'cancelled', { timeoutMs: 10_000 });
  report.cases.push({ name: 'Slack-dismiss-cancels-native-form', nativeCancelled: true });

  for (const count of [11, 100, 105, 2000]) {
    const options = Array.from({ length: count }, (_, index) => ({ label: `Provider ${index + 1} ${'x'.repeat(55)}`, value: `provider-${index}` }));
    const list = await create([{ key: 'provider', type: 'string', required: true, custom: false, options }], { title: 'Choose a web search provider', metadata: { kind: 'websearch.provider' } });
    if (count <= 100) {
      const select = actions().find(item => item.type === 'static_select');
      assert.equal(select.options.length, count);
      const block = card.blocks.find(block => block.elements?.includes(select));
      await click('submit', { raw: { state: { values: { [block.block_id]: { [select.action_id]: { selected_option: select.options.at(-1) } } } } } });
    } else {
      if (count === 2000) assert.ok(attachments.at(-1).files[0].data.toString().includes('2000. Provider 2000'));
      await text(String(count));
    }
    assert.deepEqual((await answered(list.id)).state.answer, { provider: `provider-${count - 1}` });
    report.cases.push({ name: `source-shaped-websearch-provider-list-${count}`, nativeAnswerConfirmed: true, SlackSizeAssertionsPassed: true });
  }

  const consent = await create([{ key: 'choice', type: 'string', required: true, custom: false,
    description: 'Allow OpenCode to search the web for up-to-date information?',
    options: [{ value: 'allow', label: 'Allow search via Local test' }, { value: 'choose', label: 'Choose another provider' }, { value: 'disable', label: 'Disable web search' }] }],
    { title: 'Web Search', metadata: { kind: 'websearch.provider' } });
  selector = actions().find(item => item.type === 'radio_buttons');
  await click('select', { value: selector.options[1].value });
  await click('submit');
  assert.deepEqual((await answered(consent.id)).state.answer, { choice: 'choose' });
  report.cases.push({ name: 'source-shaped-websearch-consent', chooseAnotherProviderPreserved: true });

  const multiline = await create([{ key: 'body', type: 'string', required: true, pattern: '^first\\nsecond$', default: '' }]);
  await text('first\nsecond');
  assert.deepEqual((await answered(multiline.id)).state.answer, { body: 'first\nsecond' });
  report.cases.push({ name: 'native-multiline-pattern-validation', newlinePreserved: true });

  const url = `https://example.com/continue?state=${'x'.repeat(3100)}`;
  const oversized = await create([{ key: 'external', type: 'external', title: 'Long title '.repeat(20), description: 'Full instructions '.repeat(200), url }], { title: 'Long form title '.repeat(20) });
  assert.ok(attachments.at(-1).files[0].data.toString().includes(url));
  assert.ok(!actions().some(item => item.url?.length > 3000));
  assert.equal((await detail(oversized.id)).state.status, 'pending');
  await click('finished');
  assert.deepEqual((await answered(oversized.id)).state.answer, { external: true });
  report.cases.push({ name: 'oversized-external-link-title-description', fullDetailsAttached: true, explicitCompletionRequired: true });

  const defaults = await create([
    { key: 'false', type: 'boolean', required: true, hidden: true, default: false },
    { key: 'zero', type: 'integer', required: true, hidden: true, default: 0 },
    { key: 'empty', type: 'string', required: false, hidden: true, default: '' },
  ]);
  assert.equal((await detail(defaults.id)).state.status, 'pending');
  await click('submit');
  assert.deepEqual((await answered(defaults.id)).state.answer, { false: false, zero: 0, empty: '' });
  report.cases.push({ name: 'all-hidden-defaults-explicit-submit', falseZeroEmptyPreserved: true });

  const optional = await create([
    { key: 'omitted', type: 'string', required: false, default: 'default-value' },
    { key: 'other', type: 'string', required: false },
    { key: 'inactive', type: 'integer', required: true, when: [{ key: 'other', op: 'neq', value: 'x' }] },
    { key: 'list', type: 'multiselect', required: false, options: [{ label: 'One', value: '1' }] },
  ]);
  await click('skip');
  await click('skip');
  selector = actions().find(item => item.type === 'checkboxes');
  const listBlock = card.blocks.find(block => block.elements?.includes(selector));
  await click('submit', { raw: { state: { values: { [listBlock.block_id]: { [selector.action_id]: { selected_options: [] } } } } } });
  assert.deepEqual((await answered(optional.id)).state.answer, { omitted: 'default-value', list: [] });
  report.cases.push({ name: 'omission-defaults-empty-array-and-inactive-condition', nativeAnswerConfirmed: true });

  const generated = await client.session.create({ location: { directory: runtime.workspace } }, { signal: runtime.signal });
  await adapter.followSession({ sessionId: generated.id, workingDirectory: runtime.workspace, controller,
    onInteraction: interaction => { requests.push(interaction); return controls.onInteraction({ thread }, interaction); }, onResponse: () => {}, onError: () => {} });
  provider.register({ prompt: 'GENERATE_NATIVE_QUESTION', text: 'NATIVE_QUESTION_FINISHED',
    tool: { names: ['question', 'form'], arguments: (_messages, tool) => tool.name === 'question'
      ? { questions: [{ header: 'Native question', question: 'Continue from Slack?', custom: false, options: [{ label: 'Yes', description: 'Continue' }] }] }
      : { title: 'Native question', fields: [{ key: 'answer', type: 'string', required: true, options: [{ value: 'yes', label: 'Yes' }] }] },
      verify: results => assert.match(JSON.stringify(results), /Yes|yes/u) } });
  card = undefined;
  await client.session.prompt({ sessionID: generated.id, text: 'GENERATE_NATIVE_QUESTION' }, { signal: runtime.signal });
  await runtime.waitFor(() => card && requests.some(request => request.sessionId === generated.id), { timeoutMs: 20_000, label: 'actual native question tool' });
  selector = actions().find(item => item.type === 'radio_buttons');
  await click('select', { value: selector.options[0].value });
  await click('submit');
  await runtime.waitFor(async () => {
    const history = await client.message.list({ sessionID: generated.id, limit: 20 }, { signal: runtime.signal });
    return history.data.some(message => message.type === 'assistant' && message.content?.some(part => part.text === 'NATIVE_QUESTION_FINISHED'));
  }, { timeoutMs: 20_000, label: 'execution resumes after native question' });
  assert.equal(provider.receipts.filter(receipt => receipt.prompt === 'GENERATE_NATIVE_QUESTION').length, 2);
  report.cases.push({ name: 'native-tool-generated-question-resumes-execution', localModelRoundTrips: 2, completedAssistantVerified: true });
  provider.assertClean();

  report.renderedCardsChecked = cards.length;
  report.detailAttachments = attachments.length;
  report.completed = true;
} catch (error) { report.failure = { error: String(error), stack: error.stack }; process.exitCode = 1; console.error(error); }
finally {
  adapter?.stopAll();
  await adapter?.drain();
  await controls?.close();
  try { await runtime.teardown(); report.cleanupPassed = true; }
  catch (error) { report.cleanupPassed = false; report.cleanupError = String(error); process.exitCode = 1; }
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
