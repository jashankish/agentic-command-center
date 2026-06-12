import { app } from 'electron'

// Test/demo harness: point the app at a throwaway profile (synthetic repos
// and session data for screenshots or experiments) without touching the real
// one. This lives in its own module imported *first* by main/index.ts —
// electron-store resolves its config path the moment store.ts evaluates, so
// the override must run before any other main-process module.
if (process.env.ACC_USER_DATA) app.setPath('userData', process.env.ACC_USER_DATA)
