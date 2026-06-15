# RPA Registration Notes: deepseek

The generated source artifacts compile as reviewable templates. To make this provider active in Chat2API, review the learned protocol and then wire these generated classes into:

- `src/main/providers/builtin/index.ts`
- `src/main/store/types.ts` `BUILTIN_PROVIDERS`
- `src/main/proxy/adapters/index.ts`
- `src/main/proxy/forwarder.ts` provider forwarder list
- renderer i18n/provider icon mapping, if this should be visible as a built-in provider

Suggested adapter classes:

- `DeepseekAdapter`
- `DeepseekStreamHandler`

Keep this file with the learning summary until the generated provider has been manually reviewed.
