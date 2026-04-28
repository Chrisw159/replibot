import { useGetBetfairStatus, useConnectBetfair, useGetBetfairAccount } from "@workspace/api-client-react";
import { formatCurrency } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useQueryClient } from "@tanstack/react-query";
import { getGetBetfairStatusQueryKey, getGetBetfairAccountQueryKey } from "@workspace/api-client-react";
import { CheckCircle2, XCircle, Shield } from "lucide-react";

const connectSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
  appKey: z.string().min(1, "App Key is required"),
});

export default function Settings() {
  const { data: status, isLoading: loadingStatus } = useGetBetfairStatus();
  const { data: account, isLoading: loadingAccount } = useGetBetfairAccount({ query: { enabled: !!status?.connected, queryKey: getGetBetfairAccountQueryKey() } });
  
  const connect = useConnectBetfair();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const form = useForm<z.infer<typeof connectSchema>>({
    resolver: zodResolver(connectSchema),
    defaultValues: {
      username: "",
      password: "",
      appKey: "",
    },
  });

  const onSubmit = (data: z.infer<typeof connectSchema>) => {
    connect.mutate({ data }, {
      onSuccess: (res) => {
        if (res.connected) {
          toast({ title: "Connected to Betfair API successfully" });
          form.reset();
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

      <div className="grid gap-6">
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

            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
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
                    control={form.control}
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
                  control={form.control}
                  name="appKey"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Application Key</FormLabel>
                      <FormControl>
                        <Input {...field} className="bg-background/50 font-mono" placeholder="Live app key from Betfair Developer" />
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
