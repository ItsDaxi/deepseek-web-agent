// How much of a chat's context is used. DeepSeek counts the tokens itself and sends the running
// total of the chat as accumulated_token_usage, so nothing is estimated here. The limit comes from
// the model settings the page already loads. This only reads: it never changes what the page sees.
(function (root) {
  'use strict';

  const isCount = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

  // The token total after the newest message of a chat, from the parsed history_messages payload.
  // The message the chat currently ends on wins; otherwise the last message that carries a total.
  function latestUsage(messages, currentMessageId) {
    if (!Array.isArray(messages)) return null;
    const current = messages.find((message) => message && message.message_id === currentMessageId);
    if (current && isCount(current.accumulated_token_usage)) return current.accumulated_token_usage;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message && isCount(message.accumulated_token_usage)) return message.accumulated_token_usage;
    }
    return null;
  }

  // The most tokens a chat can hold, from the model configs. It is the model the chat opens with:
  // the default one, or the first that is switched on. The smaller of the two limits is used, so a
  // chat is never shown as having more room than it has.
  function limitFromConfigs(configs) {
    if (!Array.isArray(configs)) return null;
    const model = configs.find((config) => config && config.enabled && config.is_default) || configs.find((config) => config && config.enabled);
    const feature = model && model.file_feature;
    if (!feature) return null;
    const limits = [feature.token_limit, feature.token_limit_with_thinking].filter(isCount);
    return limits.length ? Math.min(...limits) : null;
  }

  // From the parsed answer of /api/v0/client/settings?scope=model. The page does not ask again
  // while its saved copy is current, so the answer may not hold the configs.
  function contextLimit(payload) {
    const biz = payload && payload.data && payload.data.biz_data;
    return limitFromConfigs(biz && biz.settings && biz.settings.model_configs && biz.settings.model_configs.value);
  }

  // From the copy the page keeps in localStorage (__ds_remote_feature_store_model), as a string.
  function storedContextLimit(raw) {
    let state = null;
    try {
      state = JSON.parse(raw);
    } catch {
      return null;
    }
    return limitFromConfigs(state && state.entries && state.entries.model_configs && state.entries.model_configs.value);
  }

  function trimZero(text) {
    return text.replace(/\.0$/, '');
  }

  // 999 -> "999", 1606 -> "1.6K", 125000 -> "125K", 890880 -> "891K", 1200000 -> "1.2M".
  function formatTokens(count) {
    const value = Math.max(0, Math.round(Number(count) || 0));
    if (value < 1000) return String(value);
    if (value < 100000) return `${trimZero((value / 1000).toFixed(1))}K`;
    if (value < 999500) return `${Math.round(value / 1000)}K`;
    return `${trimZero((value / 1000000).toFixed(1))}M`;
  }

  const api = { latestUsage, contextLimit, storedContextLimit, formatTokens };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DsxContextUsage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
