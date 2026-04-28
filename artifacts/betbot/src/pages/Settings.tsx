import { useEffect, useState } from "react";
import { useGetBetfairStatus, useConnectBetfair, useGetBetfairAccount } from "@workspace/api-client-react";
import { formatCurrency } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormDescription } from "@/components/ui/form";
import { useQueryClient } from "@tanstack/react-query";
import { getGetBetfairStatusQueryKey, getGetBetfairAccountQueryKey } from "@workspace/api-client-react";
import { CheckCircle2, XCircle, Shield, AlertTriangle, Bot, Eye, EyeOff, Trash2 } from "lucide-react";

const connectSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
  appKey: z.string().min(1, "App Key is required"),
});

const apiKeySchema = z.object({
  apiKey: z.string().min(10, "Please enter a valid API key"),
});

export default function Settings() {
  const { data: status, isLoading: loadingStatus } = useGetBetfairStatus();
  const { data: account } = useGetBetfairAccount({ query: { enabled: !!status?.connected, queryKey: getGetBetfairAccountQueryKey() } });

  const connect = useConnectBetfair();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // xAI key state
  const [keyStatus, setKeyStatus] = useState<{ hasXaiApiKey: boolean; xaiApiKeyHint: string | null } | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [removingKey, setRemovingKey] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then(r => r.json())
      .then(setKeyStatus)
      .catch(() => {});
  }, []);

  const apiKeyForm = useForm<z.infer<typeof apiKeySchema>>({
    resolver: zodResolver(apiKeySchema),
    defaultValues: { apiKey: "" },
  });

  const saveApiKey = async (values: z.infer<typeof apiKeySchema>) => {
    setSavingKey(true);
    try {
      const res = await fetch("/api/settings/xai-api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: values.apiKey }),
      });
      if (res.ok) {
        toast({ title: "API key saved" });
        apiKeyForm.reset();
        const updated = await fetch("/api/settings").then(r => r.json());
        setKeyStatus(updated);
      } else {
        toast({ title: "Failed to save API key", variant: "destructive" });
      }
    } finally {
      setSavingKey(false);
    }
  };

  const removeApiKey = async () => {
    if (!confirm("Remove the saved xAI API key?")) return;
    setRemovingKey(true);
    try {
      await fetch("/api/settings/xai-api-key", { method: "DELETE" });
      toast({ title: "API key removed" });
      setKeyStatus({ hasXaiApiKey: false, xaiApiKeyHint: null });
    } finally {
      setRemovingKey(false);
    }
  };

  const betfairForm = useForm<z.infer<typeof connectSchema>>({
    resolver: zodResolver(connectSchema),
    defaultValues: { username: "", password: "", appKey: "" },
  });

  const onConnectBetfair = (data: z.infer<typeof connectSchema>) => {
    connect.mutate({ data }, {
      onSuccess: (res) => {
        if (res.connected) {
          toast({ title: "Connected to Betfair API successfully" });
          betfairForm.reset();
          queryClient.invalidateQueries({ queryKey: getGetBetfairStatusQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetBetfairAccountQueryKey() });
        } else {
          toast({ variant: "destructive", title: "Connection failed", description: res.error || "Unknown error" });
        }
      },
      onError: (err) => {
        toast({ variant: "destructive", title: "Connection failed", description: err instanceof Error ? err.message : "Network error" });
      }
    });
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
      </div>

      <div className="flex items-start gap-3 p-4 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-300">
        <AlertTriangle className="w-5 h-5 mt-0.5 flex-shrink-0" />
        <div className="text-sm">
          <p className="font-semibold mb-1">Geo-restriction notice</p>
          <p className="text-amber-300/80">
            Betfair blocks API access from US-based servers. This development environment runs in the US, so live Betfair connections will be rejected. All other features (strategies, P&amp;L tracking, paper trading) work fully. To use live market data and real betting, <strong className="text-amber-300">deploy this app to your Hetzner server</strong>.
          </p>
        </div>
      </div>

      <div className="grid gap-6">

        {/* xAI / Grok API Key */}
        <Card className="border-border/50 bg-card/50">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Bot className="w-5 h-5" />
              AI Provider — Grok (xAI)
            </CardTitle>
            <CardDescription>
              The bot uses Grok to analyse markets and make betting decisions.
              Get your API key from <a href="https://console.x.ai" target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">console.x.ai</a>.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">

            {/* Current key status */}
            {keyStatus?.hasXaiApiKey && (
              <div className="flex items-center justify-between p-3 rounded-lg bg-chart-1/10 border border-chart-1/30">
                <div className="flex items-center gap-3">
                  <CheckCircle2 className="w-5 h-5 text-chart-1" />
                  <div>
                    <div className="font-medium text-sm text-chart-1">API key saved</div>
                    <div className="font-mono text-xs text-muted-foreground">{keyStatus.xaiApiKeyHint}</div>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive hover:bg-destructive/10 gap-2"
                  onClick={removeApiKey}
                  disabled={removingKey}
                >
                  <Trash2 className="w-4 h-4" />
                  Remove
                </Button>
              </div>
            )}

            {/* Key input form */}
            <Form {...apiKeyForm}>
              <form onSubmit={apiKeyForm.handleSubmit(saveApiKey)} className="space-y-3">
                <FormField
                  control={apiKeyForm.control}
                  name="apiKey"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{keyStatus?.hasXaiApiKey ? "Replace API Key" : "xAI API Key"}</FormLabel>
                      <div className="flex gap-2">
                        <div className="relative flex-1">
                          <FormControl>
                            <Input
                              {...field}
                              type={showKey ? "text" : "password"}
                              placeholder="xai-..."
                              className="bg-background/50 font-mono pr-10"
                              autoComplete="off"
                            />
                          </FormControl>
                          <button
                            type="button"
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                            onClick={() => setShowKey(v => !v)}
                          >
                            {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                        <Button type="submit" disabled={savingKey}>
                          {savingKey ? "Saving..." : keyStatus?.hasXaiApiKey ? "Replace" : "Save"}
                        </Button>
                      </div>
                      <FormDescription>Stored securely in the database. Never exposed in full.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </form>
            </Form>
          </CardContent>
        </Card>

        {/* Betfair Connection */}
        <Card className="border-border/50 bg-card/50">
          <CardHeader>
            <CardTitle className="text-lg">Exchange Connection</CardTitle>
            <CardDescription>Manage your connection to the Betfair API</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between p-4 rounded-lg bg-muted/30 border border-border/50 mb-6">
              <div className="flex items-center gap-3">
                {status?.connected ? (
                  <CheckCircle2 className="w-6 h-6 text-chart-1" />
                ) : (
                  <XCircle className="w-6 h-6 text-destructive" />
                )}
                <div>
                  <div className="font-semibold">{status?.connected ? "Connected to Betfair" : "Disconnected"}</div>
                  <div className="text-sm text-muted-foreground">
                    {status?.connected ? `Session active as ${status.username || 'user'}` : "API credentials required"}
                  </div>
                </div>
              </div>
              {status?.connected && account && (
                <div className="text-right">
                  <div className="text-xs text-muted-foreground">Available Balance</div>
                  <div className="text-xl font-bold font-mono text-chart-1">{formatCurrency(account.availableToBetBalance, account.currency)}</div>
                  <div className="text-xs text-muted-foreground mt-1">Exposure: {formatCurrency(account.exposure, account.currency)}</div>
                </div>
              )}
            </div>

            <Form {...betfairForm}>
              <form onSubmit={betfairForm.handleSubmit(onConnectBetfair)} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <FormField
                    control={betfairForm.control}
                    name="username"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Betfair Username</FormLabel>
                        <FormControl>
                          <Input {...field} className="bg-background/50" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={betfairForm.control}
                    name="password"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Betfair Password</FormLabel>
                        <FormControl>
                          <Input type="password" {...field} className="bg-background/50" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={betfairForm.control}
                  name="appKey"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Application Key</FormLabel>
                      <FormControl>
                        <Input {...field} className="bg-background/50 font-mono" placeholder="Live app key from Betfair Developer portal" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="flex items-center gap-4 pt-4 border-t border-border/50">
                  <Button type="submit" disabled={connect.isPending} className="px-8">
                    {connect.isPending ? "Connecting..." : status?.connected ? "Reconnect" : "Connect"}
                  </Button>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Shield className="w-4 h-4" />
                    Credentials are encrypted in transit.
                  </div>
                </div>
              </form>
            </Form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
