"use client"

import { useCallback, useEffect, useState } from "react"
import {
  CheckCircle2,
  GitBranch,
  Github,
  Loader2,
  Save,
  Trash2,
  XCircle,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  detectGit,
  getGitSettings,
  updateGitSettings,
  testGitPath,
  getGitHubAccounts,
  updateGitHubAccounts,
  validateGitHubToken,
} from "@/lib/tauri"
import type {
  GitDetectResult,
  GitHubAccount,
  GitHubAccountsSettings,
} from "@/lib/types"
import { AddGitHubAccountDialog } from "./add-github-account-dialog"

export function VersionControlSettings() {
  const t = useTranslations("VersionControlSettings")

  const [loading, setLoading] = useState(true)
  const [gitInfo, setGitInfo] = useState<GitDetectResult | null>(null)
  const [customPath, setCustomPath] = useState("")
  const [savingGit, setSavingGit] = useState(false)
  const [testingGit, setTestingGit] = useState(false)
  const [testResult, setTestResult] = useState<GitDetectResult | null>(null)

  const [accounts, setAccounts] = useState<GitHubAccountsSettings>({
    accounts: [],
  })
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [testingAccountId, setTestingAccountId] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<GitHubAccount | null>(null)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [git, settings, ghAccounts] = await Promise.all([
        detectGit(),
        getGitSettings(),
        getGitHubAccounts(),
      ])
      setGitInfo(git)
      setCustomPath(settings.custom_path ?? "")
      setAccounts(ghAccounts)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(t("loadFailed", { message }))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    loadData().catch(console.error)
  }, [loadData])

  const handleTestGit = useCallback(async () => {
    const pathToTest = customPath.trim() || "git"
    setTestingGit(true)
    setTestResult(null)
    try {
      const result = await testGitPath(pathToTest)
      setTestResult(result)
      if (result.installed) {
        toast.success(t("testSuccess"))
      } else {
        toast.error(t("testFailed", { message: "not a valid git executable" }))
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(t("testFailed", { message }))
    } finally {
      setTestingGit(false)
    }
  }, [customPath, t])

  const handleSaveGit = useCallback(async () => {
    setSavingGit(true)
    try {
      await updateGitSettings({
        custom_path: customPath.trim() || null,
      })
      const git = await detectGit()
      setGitInfo(git)
      toast.success(t("saveSuccess"))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(t("saveFailed", { message }))
    } finally {
      setSavingGit(false)
    }
  }, [customPath, t])

  const handleAccountAdded = useCallback(
    async (account: GitHubAccount) => {
      const updated: GitHubAccountsSettings = {
        accounts: [
          ...accounts.accounts.map((a) =>
            account.is_default ? { ...a, is_default: false } : a
          ),
          account,
        ],
      }
      try {
        const saved = await updateGitHubAccounts(updated)
        setAccounts(saved)
        toast.success(t("addSuccess", { username: account.username }))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        toast.error(t("addFailed", { message }))
      }
    },
    [accounts, t]
  )

  const handleTestConnection = useCallback(
    async (account: GitHubAccount) => {
      setTestingAccountId(account.id)
      try {
        const result = await validateGitHubToken(
          account.server_url,
          account.token
        )
        if (result.success) {
          toast.success(t("connectionSuccess"))
        } else {
          toast.error(
            t("connectionFailed", {
              message: result.message ?? "Unknown error",
            })
          )
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        toast.error(t("connectionFailed", { message }))
      } finally {
        setTestingAccountId(null)
      }
    },
    [t]
  )

  const handleSetDefault = useCallback(
    async (accountId: string) => {
      const updated: GitHubAccountsSettings = {
        accounts: accounts.accounts.map((a) => ({
          ...a,
          is_default: a.id === accountId,
        })),
      }
      try {
        const saved = await updateGitHubAccounts(updated)
        setAccounts(saved)
        toast.success(t("defaultSet"))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        toast.error(message)
      }
    },
    [accounts, t]
  )

  const handleRemoveAccount = useCallback(async () => {
    if (!removeTarget) return
    const updated: GitHubAccountsSettings = {
      accounts: accounts.accounts.filter((a) => a.id !== removeTarget.id),
    }
    try {
      const saved = await updateGitHubAccounts(updated)
      setAccounts(saved)
      toast.success(t("removeSuccess"))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(message)
    } finally {
      setRemoveTarget(null)
    }
  }, [accounts, removeTarget, t])

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("loading")}
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto">
      <div className="w-full space-y-4">
        <section className="space-y-1">
          <h1 className="text-sm font-semibold">{t("sectionTitle")}</h1>
          <p className="text-xs text-muted-foreground">
            {t("sectionDescription")}
          </p>
        </section>

        {/* Git Configuration */}
        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">{t("gitTitle")}</h2>
          </div>

          <p className="text-xs text-muted-foreground leading-5">
            {t("gitDescription")}
          </p>

          {/* Git status */}
          <div className="rounded-md border bg-muted/20 px-3 py-3 text-xs space-y-2">
            <div className="flex items-center gap-2">
              {gitInfo?.installed ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                  <span className="text-green-600 dark:text-green-400 font-medium">
                    {t("gitDetected")}
                  </span>
                </>
              ) : (
                <>
                  <XCircle className="h-3.5 w-3.5 text-red-500" />
                  <span className="text-red-600 dark:text-red-400 font-medium">
                    {t("gitNotFound")}
                  </span>
                </>
              )}
            </div>
            {gitInfo?.version && (
              <p className="text-muted-foreground">
                {t("gitVersion")}: {gitInfo.version}
              </p>
            )}
            {gitInfo?.path && (
              <p className="text-muted-foreground">
                {t("gitPath")}: {gitInfo.path}
              </p>
            )}
          </div>

          {/* Custom path */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              {t("customGitPath")}
            </label>
            <div className="flex gap-2">
              <Input
                value={customPath}
                onChange={(e) => {
                  setCustomPath(e.target.value)
                  setTestResult(null)
                }}
                placeholder={t("customGitPathPlaceholder")}
                className="flex-1"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={handleTestGit}
                disabled={testingGit}
              >
                {testingGit ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t("testing")}
                  </>
                ) : (
                  t("test")
                )}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {t("customGitPathHint")}
            </p>
            {testResult && (
              <div
                className={`flex items-center gap-1.5 text-xs ${
                  testResult.installed
                    ? "text-green-600 dark:text-green-400"
                    : "text-red-600 dark:text-red-400"
                }`}
              >
                {testResult.installed ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : (
                  <XCircle className="h-3 w-3" />
                )}
                {testResult.installed
                  ? `${t("testSuccess")} (${testResult.version})`
                  : t("testFailed", { message: "invalid" })}
              </div>
            )}
          </div>

          <div className="flex justify-end">
            <Button size="sm" onClick={handleSaveGit} disabled={savingGit}>
              {savingGit ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t("saving")}
                </>
              ) : (
                <>
                  <Save className="h-3.5 w-3.5" />
                  {t("save")}
                </>
              )}
            </Button>
          </div>
        </section>

        {/* GitHub Accounts */}
        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Github className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">{t("githubTitle")}</h2>
          </div>

          <p className="text-xs text-muted-foreground leading-5">
            {t("githubDescription")}
          </p>

          {/* Account list */}
          {accounts.accounts.length === 0 ? (
            <div className="rounded-md border border-dashed bg-muted/10 px-4 py-6 text-center text-xs text-muted-foreground">
              {t("noAccounts")}
            </div>
          ) : (
            <div className="space-y-2">
              {accounts.accounts.map((account) => (
                <div
                  key={account.id}
                  className="flex items-center gap-3 rounded-lg border bg-muted/10 px-3 py-2.5"
                >
                  {/* Avatar */}
                  {account.avatar_url ? (
                    <img
                      src={account.avatar_url}
                      alt={account.username}
                      className="h-8 w-8 rounded-full"
                    />
                  ) : (
                    <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
                      {account.username[0]?.toUpperCase()}
                    </div>
                  )}

                  {/* Info */}
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">
                        {account.username}
                      </span>
                      {account.is_default && (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                          {t("defaultLabel")}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="truncate">{account.server_url}</span>
                      {account.scopes.length > 0 && (
                        <>
                          <span>·</span>
                          <span className="truncate">
                            {account.scopes.join(", ")}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => handleTestConnection(account)}
                      disabled={testingAccountId === account.id}
                    >
                      {testingAccountId === account.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        t("testConnection")
                      )}
                    </Button>
                    {!account.is_default && (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => handleSetDefault(account.id)}
                      >
                        {t("setDefault")}
                      </Button>
                    )}
                    <Button
                      size="xs"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setRemoveTarget(account)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-end">
            <Button size="sm" onClick={() => setAddDialogOpen(true)}>
              {t("addAccount")}
            </Button>
          </div>
        </section>
      </div>

      {/* Add Account Dialog */}
      <AddGitHubAccountDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        onAccountAdded={handleAccountAdded}
        isFirstAccount={accounts.accounts.length === 0}
      />

      {/* Remove Confirmation */}
      <AlertDialog
        open={!!removeTarget}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("removeConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("removeConfirmMessage", {
                username: removeTarget?.username ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("removeCancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleRemoveAccount}>
              {t("removeConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
