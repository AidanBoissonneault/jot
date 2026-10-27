export default {
  async fetch(request, env) {
    return env.JOTTATHING_CORE.fetch(request);
  },
};
