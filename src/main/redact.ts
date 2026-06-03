/**
 * Scrub credentials from text before it leaves the main process (e.g. git/gh
 * error messages shown in the UI). Covers the cases where a secret could
 * realistically appear in an error string:
 *   - URL userinfo:        https://user:TOKEN@github.com/...  → https://***:***@github.com/...
 *   - GitHub token formats: gho_/ghp_/ghs_/ghu_/ghr_ + github_pat_...
 *   - Anthropic tokens:     sk-ant-... (oat/api) and `Bearer <token>` headers
 */
export function redactSecrets(input: string): string {
  return input
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, '//***:***@')
    .replace(/\b(gh[opsur]_[A-Za-z0-9]{20,})\b/g, '***')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '***')
    .replace(/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, '***')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{20,}/g, 'Bearer ***')
}

/** Normalize an unknown thrown value into a redacted message string. */
export function redactError(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err))
}
