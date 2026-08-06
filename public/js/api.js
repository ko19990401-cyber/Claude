async function request(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body && !(options.body instanceof FormData)
      ? { 'content-type': 'application/json', ...options.headers }
      : options.headers,
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload?.error?.message || `通信に失敗しました (HTTP ${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

export const api = {
  system: () => request('/api/system'),
  presets: () => request('/api/presets'),
  estimate: (body) => request('/api/estimate', { method: 'POST', body: JSON.stringify(body) }),

  listJobs: () => request('/api/jobs'),
  getJob: (id) => request(`/api/jobs/${id}`),
  renameJob: (id, title) => request(`/api/jobs/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  deleteJob: (id) => request(`/api/jobs/${id}`, { method: 'DELETE' }),
  retryJob: (id) => request(`/api/jobs/${id}/retry`, { method: 'POST' }),
  cancelJob: (id) => request(`/api/jobs/${id}/cancel`, { method: 'POST' }),

  updateSpeakers: (id, speakers) =>
    request(`/api/jobs/${id}/speakers`, { method: 'PATCH', body: JSON.stringify({ speakers }) }),
  updateSegment: (id, segId, patch) =>
    request(`/api/jobs/${id}/segments/${segId}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  applyGlossary: (id, glossaryId) =>
    request(`/api/jobs/${id}/glossary/apply`, { method: 'POST', body: JSON.stringify({ glossaryId }) }),
  revertGlossary: (id) => request(`/api/jobs/${id}/glossary/revert`, { method: 'POST' }),

  deleteSummary: (id, summaryId) => request(`/api/jobs/${id}/summaries/${summaryId}`, { method: 'DELETE' }),

  listGlossaries: () => request('/api/glossaries'),
  getGlossary: (id) => request(`/api/glossaries/${id}`),
  saveGlossary: (id, body) => request(`/api/glossaries/${id}`, { method: 'PUT', body: JSON.stringify(body) }),

  exportUrl: (id, params) => `/api/jobs/${id}/export?${new URLSearchParams(params)}`,
  audioUrl: (id) => `/api/jobs/${id}/audio`,

  /** アップロード（進捗を取りたいので XHR を使う） */
  upload(file, fields, { onProgress } = {}) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) {
        if (v !== null && v !== undefined && v !== '') form.append(k, String(v));
      }
      form.append('file', file, file.name);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/jobs');
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) onProgress?.(e.loaded / e.total);
      });
      xhr.addEventListener('load', () => {
        try {
          const body = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) resolve(body);
          else reject(new Error(body?.error?.message || `アップロードに失敗しました (HTTP ${xhr.status})`));
        } catch {
          reject(new Error(`アップロードに失敗しました (HTTP ${xhr.status})`));
        }
      });
      xhr.addEventListener('error', () => reject(new Error('アップロード中に通信エラーが発生しました')));
      xhr.send(form);
    });
  },
};

/** ジョブ進捗のSSE購読。返り値を呼ぶと購読解除。 */
export function subscribeJob(jobId, handlers) {
  const source = new EventSource(`/api/jobs/${jobId}/events`);
  for (const [type, handler] of Object.entries(handlers)) {
    source.addEventListener(type, (event) => {
      try { handler(JSON.parse(event.data)); } catch { /* 壊れたイベントは黙って捨てる */ }
    });
  }
  return () => source.close();
}

/**
 * 要約生成（POST + SSE）。EventSource は POST できないので fetch でストリームを読む。
 * @returns {{promise: Promise<void>, abort: () => void}}
 */
export function streamSummary(jobId, body, handlers) {
  const controller = new AbortController();
  const promise = (async () => {
    const res = await fetch(`/api/jobs/${jobId}/summarize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload?.error?.message || `要約に失敗しました (HTTP ${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';
      for (const frame of frames) {
        let event = 'message';
        const dataLines = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue;
        try { handlers[event]?.(JSON.parse(dataLines.join('\n'))); } catch { /* ignore */ }
      }
    }
  })();
  return { promise, abort: () => controller.abort() };
}
