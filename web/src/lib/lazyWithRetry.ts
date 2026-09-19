import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

type DefaultExportModule<T> = { default: T }

/** Retry dynamic imports — helps after EXE rebuilds when hashed chunk names change. */
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<DefaultExportModule<T>>,
  retries = 2,
  delayMs = 450,
): LazyExoticComponent<T> {
  return lazy(async () => {
    let lastError: unknown
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await factory()
      } catch (error) {
        lastError = error
        if (attempt < retries) {
          await new Promise((resolve) => window.setTimeout(resolve, delayMs * (attempt + 1)))
        }
      }
    }
    throw lastError
  })
}
