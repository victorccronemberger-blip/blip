import { createMemo } from "solid-js"
import { useSync } from "@tui/context/sync"
import { filter, map, pipe, sortBy } from "remeda"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { PROVIDER_PRIORITY } from "@/util/provider-priority"

// Native provider manager (mirrors DialogProvider / "Connect a provider").
// Removing makes a provider "clean/new", as if it was never registered: it
// deletes the saved API key (auth.remove) AND hides it via `disabled_providers`
// (provider.ts drops disabled providers from the state, so they vanish from the
// model list and /connect). It's still reversible: this same dialog lists the
// removed providers so you can restore one — it reappears in /connect as a fresh,
// unregistered provider (no key), ready to connect again. No file editing.
export function DialogProviderRemove() {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()

  // Flip a provider's disabled state, then refresh and re-open the manager.
  // On remove we also clear the saved key so the provider goes back to a clean,
  // unregistered state; restoring only un-hides it (the key is not brought back).
  async function setDisabled(id: string, disabled: boolean, label: string) {
    if (disabled) {
      await sdk.client.auth.remove({ providerID: id }).catch(() => {})
    }
    const current = sync.data.config?.disabled_providers ?? []
    const next = disabled
      ? Array.from(new Set([...current, id]))
      : current.filter((p) => p !== id)
    const upd = await sdk.client.global.config.update({
      config: { disabled_providers: next } as any,
    })
    if (upd.error) {
      toast.show({ variant: "error", message: JSON.stringify(upd.error) })
      dialog.clear()
      return
    }
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    toast.show({ variant: "info", message: disabled ? `Removed ${label}` : `Restored ${label}` })
    // Re-open so several can be toggled in one sitting; Esc closes.
    dialog.replace(() => <DialogProviderRemove />)
  }

  const options = createMemo(() => {
    const disabledSet = new Set(sync.data.config?.disabled_providers ?? [])
    const connectedIds = sync.data.provider_next.connected

    // Active, removable providers (currently in the model list).
    const active = pipe(
      sync.data.provider_next.all,
      filter((p) => connectedIds.includes(p.id) && !disabledSet.has(p.id)),
      sortBy((x) => PROVIDER_PRIORITY[x.id] ?? 99),
      map((provider) => ({
        title: provider.name,
        value: `active:${provider.id}`,
        category: "Active — select to remove",
        gutter: <text fg={theme.success}>✓</text>,
        async onSelect() {
          await setDisabled(provider.id, true, provider.name)
        },
      })),
    )

    // Previously removed providers — select to restore (re-enable).
    const removed = [...disabledSet].sort().map((id) => ({
      title: id,
      value: `removed:${id}`,
      category: "Removed — select to restore",
      gutter: <text fg={theme.textMuted}>✗</text>,
      async onSelect() {
        await setDisabled(id, false, id)
      },
    }))

    const all = [...active, ...removed]
    if (all.length === 0) {
      return [{ title: "No providers to manage", value: "__none__", disabled: true }]
    }
    return all
  })

  return (
    <DialogSelect
      title="Manage providers"
      hint="Remove = clear its key + hide it (reversible). Restore brings it back keyless."
      options={options()}
    />
  )
}
