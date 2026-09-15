import axios from 'axios'

export const apiClient = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000',
  timeout: 120_000,
  headers: { 'Content-Type': 'application/json' },
})

apiClient.interceptors.response.use(
  (res) => res,
  (err) => {
    // FastAPI puts the real cause in data.detail — but pydantic validation
    // errors send an array there; stringify anything non-string so the UI
    // never shows "[object Object]".
    const detail = err.response?.data?.detail
    const message = typeof detail === 'string' && detail
      ? detail
      : detail != null ? JSON.stringify(detail)
      : err.message ?? 'Unknown error'
    return Promise.reject(new Error(message))
  }
)
