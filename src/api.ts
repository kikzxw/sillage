export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch('/api/' + path, { ...init, cache: 'no-store', redirect: 'error' })
  if (!response.ok) {
    const error = await response.json<{ error?: string }>().catch(() => ({} as { error?: string }))
    throw new ApiError(error.error || 'Le service est momentanément indisponible.', response.status)
  }
  return response.json() as Promise<T>
}

export function post<T>(path: string, body: unknown) {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
