// Built-in tool registration, not an external-code/plugin loader.
(() => {
  const tools = new Map();
  window.FlowHubTools = {
    register(tool) { if (!tool.id || tools.has(tool.id)) throw new Error('Duplicate tool id'); tools.set(tool.id, tool); },
    suggestions(context) { return [...tools.values()].filter(t => context.enabled(t.id)).flatMap(t => t.suggestions(context) || []); },
    queryChanged(context) { for (const tool of tools.values()) tool.queryChanged?.({...context, active:context.enabled(tool.id)}); },
    render(item, context) { return tools.get(item.toolId)?.render?.(item, context); },
    choose(item, context) { return tools.get(item.toolId)?.choose?.(item, context); },
    action(id, action, target, context) { return tools.get(id)?.action?.(action, target, context); }
  };
})();
