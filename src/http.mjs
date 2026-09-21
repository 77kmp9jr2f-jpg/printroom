export async function readJsonBody(stream, limit = 262_144) {
  let size = 0;
  const chunks = [];
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new Error('Response exceeds size limit');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function getPrinterJson(config, path, timeoutMs) {
  const response = await fetch(`${config.moonraker}${path}`, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: config.apiKey ? { 'X-Api-Key': config.apiKey } : {} });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
  return readJsonBody(response.body);
}
