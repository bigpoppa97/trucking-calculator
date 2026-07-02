import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// Vitest runs without injected globals, so RTL's automatic cleanup does not
// self-register — do it explicitly or DOM accumulates across tests.
afterEach(cleanup)
