import type { EffectivePermission } from "./auto-contract"

// Fail-closed effective permission for auto mode. Input is the app-side
// snapshot of the permission config; anything unrecognized denies.
// "unknown / not loaded" (OP-35 absent) -> "deny", surfaced as
// BLOQUEADO_PERMISO, never silent allow.
export function getEffectivePermission(input: {
  loaded: boolean
  allowAll?: boolean
}): EffectivePermission {
  if (!input.loaded) return "deny"
  if (input.allowAll) return "allow"
  return "ask"
}
