import { createHash, randomUUID } from "node:crypto";

function modelOption(model) {
  return {
    text: { type: "plain_text", text: (model.name || model.modelID).slice(0, 75) },
    description: { type: "plain_text", text: `${model.providerID} / ${model.modelID}`.slice(0, 75) },
    value: createHash("sha256").update(JSON.stringify([model.providerID, model.modelID])).digest("hex"),
  };
}

export function createModelPicker({ chat, botName, commands, loadConfig, listModels, setting, now = Date.now }) {
  const command = commands[0];
  const pending = new Map();
  const saves = new Set();
  let closed = false;
  const userId = (event) => event.user?.userId ?? event.user?.id;
  const authorize = (entry, event, config) => {
    if (closed || !entry || entry.expires <= now() || entry.userId !== userId(event)
      || (entry.viewId && entry.viewId !== (event.viewId ?? event.raw?.view?.id))
      || (config.allowedSlackUserIds?.length && !config.allowedSlackUserIds.includes(entry.userId))
      || (config.allowedSlackChannelIds?.length && !config.allowedSlackChannelIds.includes(entry.channelId))) {
      throw new Error(`This picker is unavailable or you are not authorized. Reopen ${command} model.`);
    }
  };
  chat.onSlashCommand?.(commands, async (event) => {
    const reply = (text) => event.channel.postEphemeral(event.user, text, { fallbackToDM: false });
    if (closed) return;
    if (event.text.trim() !== "model") return reply(`Use ${command} model to choose the default for this Pipa installation.`);
    let token;
    let failure = `I couldn't read ${botName}'s saved settings. Try ${command} model again in a moment.`;
    try {
      const config = await loadConfig();
      const channelId = event.channel.id.split(":")[1];
      failure = "Model selection isn't enabled for this account or channel. Ask the installation owner to update its access settings.";
      if (!/^[CG][A-Z0-9]+$/u.test(channelId ?? "") || !userId(event) || event.user?.isBot) throw new Error("denied");
      const entry = { userId: userId(event), channelId, expires: now() + 30 * 60_000 };
      authorize(entry, event, config);
      for (const [id, context] of pending) if (context.expires <= now()) pending.delete(id);
      // ponytail: bound abandoned modals in memory; reopen when the oldest context is evicted.
      if (pending.size >= 1000) pending.delete(pending.keys().next().value);
      token = randomUUID();
      pending.set(token, entry);
      const view = {
        type: "modal", callback_id: "pipa_model", private_metadata: JSON.stringify({ m: token }), notify_on_close: true,
        title: { type: "plain_text", text: "Pipa model" }, close: { type: "plain_text", text: "Cancel" },
      };
      failure = `Slack couldn't open the model window. Try ${command} model again in a moment.`;
      // Exchange Slack's short-lived trigger before waiting on catalog discovery.
      const opened = await event.adapter.webClient.views.open({ trigger_id: event.triggerId,
        view: { ...view, blocks: [{ type: "section", text: { type: "plain_text", text: "Loading available models…" } }] } });
      if (!opened?.view?.id) throw new Error("modal unavailable");
      entry.viewId = opened.view.id;
      failure = `I couldn't load the available models from OpenCode. Try ${command} model again in a moment.`;
      const models = await listModels();
      if (closed || !pending.has(token)) return;
      failure = `I couldn't read ${botName}'s saved settings. Try ${command} model again in a moment.`;
      const currentConfig = await loadConfig();
      if (closed || pending.get(token) !== entry) return;
      failure = "Model selection isn't enabled for this account or channel. Ask the installation owner to update its access settings.";
      authorize(entry, { ...event, viewId: entry.viewId }, currentConfig);
      failure = "I couldn't prepare the model list. This is a Pipa issue, not an access problem.";
      if (!models.length) {
        failure = "No configured models are available. Connect a provider in OpenCode, then reopen the model picker.";
        throw new Error("empty catalog");
      }
      entry.options = models.map((model) => ({ model: { providerID: model.providerID, modelID: model.modelID, name: model.name }, option: modelOption(model), search: `${model.providerID} ${model.modelID} ${model.name ?? ""}`.toLowerCase() }));
      const initialModel = currentConfig.defaultModel && models.find((model) => model.providerID === currentConfig.defaultModel.providerID && model.modelID === currentConfig.defaultModel.modelID);
      failure = `Slack couldn't display the model list. Try ${command} model again in a moment.`;
      await event.adapter.webClient.views.update({ view_id: entry.viewId, view: {
        ...view, submit: { type: "plain_text", text: "Save" },
        blocks: [{ type: "input", block_id: `pipa_model_${token}`, label: { type: "plain_text", text: `Default for new ${botName} threads` },
          hint: { type: "plain_text", text: "Up to 100 matches shown. Type a model name, ID or provider to narrow the results." },
          element: { type: "external_select", action_id: `pipa_model_${token}`, min_query_length: 0,
            placeholder: { type: "plain_text", text: "Search models or providers" }, ...(initialModel ? { initial_option: modelOption(initialModel) } : {}) } }],
      } });
    } catch (error) {
      const entry = pending.get(token);
      pending.delete(token);
      if (closed || (token && !entry)) return;
      if (error?.data?.error === "expired_trigger_id") failure = `Slack's request to open this window expired. Run ${command} model again.`;
      if (error?.data?.error === "invalid_trigger_id") failure = `Slack couldn't use the request to open this window. Run ${command} model again.`;
      if (error?.data?.error === "invalid_arguments") failure = "Slack rejected the model window. This is a Pipa issue, not an access problem.";
      const message = `${failure} Your saved model hasn't changed.`;
      if (entry?.viewId) {
        try {
          await event.adapter.webClient.views.update({ view_id: entry.viewId, view: {
            type: "modal", callback_id: "pipa_model_notice", title: { type: "plain_text", text: "Pipa model" }, close: { type: "plain_text", text: "Close" },
            blocks: [{ type: "section", text: { type: "plain_text", text: message } }],
          } });
          return;
        } catch { /* Fall back to a private message if Slack cannot update the window. */ }
      }
      await reply(message);
    }
  });

  chat.onOptionsLoad?.(async (event) => {
    if (!event.actionId?.startsWith("pipa_model_")) return;
    const entry = pending.get(event.actionId.slice("pipa_model_".length));
    try {
      authorize(entry, event, {});
      authorize(entry, event, await loadConfig());
      if (pending.get(event.actionId.slice("pipa_model_".length)) !== entry || entry.saving) return [];
      const terms = String(event.query ?? "").toLowerCase().trim().split(/\s+/u);
      const matches = [];
      for (const { option, search } of entry.options ?? []) {
        if (!terms.every((term) => search.includes(term))) continue;
        matches.push({ label: option.text.text, description: option.description.text, value: option.value });
        if (matches.length === 100) break;
      }
      return matches;
    } catch { return []; }
  });

  chat.onModalSubmit?.("pipa_model", (event) => {
    const entry = pending.get(event.privateMetadata);
    const inputId = `pipa_model_${event.privateMetadata}`;
    try {
      authorize(entry, event, {});
    } catch {
      return { action: "errors", errors: { [inputId]: `I couldn't verify this model change. Reopen ${command} model. Your saved model hasn't changed.` } };
    }
    if (entry.saving) return { action: "close" };
    entry.saving = true;
    // Acknowledge Save before config I/O and persistence work.
    const task = (async () => {
      let message;
      let failure = `I couldn't verify this model change. Reopen ${command} model. Your saved model hasn't changed.`;
      try {
        try {
          authorize(entry, event, await loadConfig());
          const model = entry.options?.find((item) => item.option.value === event.values?.[inputId])?.model;
          failure = `That model is no longer available. Reopen ${command} model and choose another. Your saved model hasn't changed.`;
          if (!model) throw new Error("unavailable model");
          failure = `I couldn't save your model choice. Reopen ${command} model to try again. Your saved model hasn't changed.`;
          await setting.save({ providerID: model.providerID, modelID: model.modelID }, (config) => authorize(entry, event, config));
          message = `New threads will use ${model.name || model.modelID}.`;
        } catch {
          message = failure;
        }
        if (closed) return;
        authorize(entry, event, await loadConfig());
        await event.adapter.postEphemeral(`slack:${entry.channelId}`, entry.userId, message);
      } finally {
        pending.delete(event.privateMetadata);
      }
    })();
    saves.add(task);
    void task.then(() => saves.delete(task), () => {
      saves.delete(task);
      if (!closed) process.stderr.write("Pipa could not deliver a private model-save result.\n");
    });
    return { action: "close" };
  });
  chat.onModalClose?.("pipa_model", (event) => {
    const entry = pending.get(event.privateMetadata);
    if (entry?.userId === userId(event) && !entry.saving) pending.delete(event.privateMetadata);
  });
  return { close() { closed = true; pending.clear(); }, async drain() { await Promise.allSettled([...saves]); } };
}
