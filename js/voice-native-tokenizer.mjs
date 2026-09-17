// Adapter for Kokoro 1.2.1's character tokenizer. The public KokoroTTS
// constructor accepts a tokenizer and a model callable, so native inference
// needs neither a browser ONNX session nor its shared-memory reservation.
// Fail closed if a future model changes this deliberately narrow contract.
export function nativeTokenizer(json, config) {
  const vocab = json?.model?.vocab;
  const norm = json?.normalizer;
  const split = json?.pre_tokenizer;
  const post = json?.post_processor;
  if (!vocab || vocab.$ !== 0 || config?.model_max_length !== 512 ||
      config?.unk_token !== '$' || norm?.type !== 'Replace' || norm.content !== '' ||
      typeof norm.pattern?.Regex !== 'string' || split?.type !== 'Split' ||
      split.pattern?.Regex !== '' || split.behavior !== 'Isolated' || split.invert ||
      post?.type !== 'TemplateProcessing' ||
      JSON.stringify(post.single) !== JSON.stringify([
        { SpecialToken: { id: '$', type_id: 0 } },
        { Sequence: { id: 'A', type_id: 0 } },
        { SpecialToken: { id: '$', type_id: 0 } },
      ]) || (json.added_tokens || []).length ||
      Object.entries(vocab).some(([char, id]) => [...char].length !== 1 || !Number.isInteger(id))) {
    throw new Error('Unsupported native voice tokenizer; update the app and voice resources together');
  }
  const remove = new RegExp(norm.pattern.Regex, 'gu');
  return function tokenize(phonemes) {
    const ids = Array.from(String(phonemes).replace(remove, ''), c => vocab[c] ?? 0);
    // The pinned tokenizer truncates the post-processed sequence from the right.
    const tokens = [0, ...ids, 0].slice(0, config.model_max_length);
    return { input_ids: { data: BigInt64Array.from(tokens, BigInt), dims: [1, tokens.length] } };
  };
}
