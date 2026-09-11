import { TextDecoder } from 'node:util';
import { failure } from '../common.mjs';
const IMAGES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const TEXT = new Set(['text/plain', 'application/json']);

export function inputParts(input) {
  const images = [], texts = [];
  for (const file of [...input.attachments, ...input.references]) {
    if (IMAGES.has(file.mediaType)) images.push(file);
    else if (TEXT.has(file.mediaType)) {
      let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); } catch { throw failure('VALIDATION_FAILED', 'Text attachment is not valid UTF-8'); }
      texts.push({ name: file.name, text, version: file.sha256 ?? file.version });
    } else throw failure('CAPABILITY_UNSUPPORTED', `This adapter cannot send ${file.mediaType} as model input. The draft and uploaded file remain available.`);
  }
  return { images, texts };
}
export function withTextFiles(text, files) {
  return [text, ...files.map(f => `\n[User-attached UTF-8 file: ${JSON.stringify(f.name)}; SHA-256: ${f.version}]\n${f.text}\n[End of user-attached file]`)].join('\n');
}
export async function verifyCommand(input, list) {
  if (!input.command) return input.text;
  const found = list.find(c => c.name === input.command.name);
  if (!found || !found.name || /[\s\x00-\x1f]/u.test(found.name)) throw failure('CAPABILITY_UNSUPPORTED', 'The selected native command is no longer in the current runtime catalog');
  // This name was returned verbatim by the runtime. No guessed prefix, alias, or case matching.
  return '/' + found.name + (input.text.trim() ? ' ' + input.text : '');
}
