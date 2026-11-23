export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export async function requestRaw(path: string, init?: RequestInit) {
  const response = await fetch('/api/' + path, { ...init, cache: 'no-store', redirect: 'error' })
  if (!response.ok) {
    const error = await response.json<{ error?: string }>().catch(() => ({} as { error?: string }))
    throw new ApiError(error.error || 'Le service est momentanément indisponible.', response.status)
  }
  return response
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return (await requestRaw(path, init)).json() as Promise<T>
}

export function post<T>(path: string, body: unknown, headers?: Record<string, string>) {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}
