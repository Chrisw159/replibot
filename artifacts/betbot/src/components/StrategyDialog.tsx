import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  useCreateStrategy,
  useUpdateStrategy,
  getListStrategiesQueryKey,
} from "@workspace/api-client-react";
import type { Strategy } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";

const EVENT_TYPES = [
  { id: "1", name: "Football (Soccer)" },
  { id: "2", name: "Tennis" },
  { id: "7", name: "Horse Racing" },
  { id: "4339", name: "Greyhound Racing" },
  { id: "4", name: "Cricket" },
  { id: "3", name: "Golf" },
  { id: "6", name: "Boxing" },
  { id: "8", name: "Motor Sport" },
];

const AI_MODELS = [
  { id: "grok-3-mini", name: "Grok 3 Mini (fast, cheap)" },
  { id: "grok-3", name: "Grok 3 (most capable)" },
  { id: "grok-3-mini-fast", name: "Grok 3 Mini Fast (fastest)" },
  { id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
  { id: "gpt-4.1", name: "GPT-4.1" },
];

function parseCountryCodes(marketFilter: string | null | undefined): { ireland: boolean; usa: boolean; australia: boolean } {
  try {
    const parsed = JSON.parse(marketFilter ?? "{}") as { countryCodes?: string[] };
    const codes = parsed.countryCodes ?? ["GB", "IE"];
    return {
      ireland: codes.includes("IE"),
      usa: codes.includes("US"),
      australia: codes.includes("AU"),
    };
  } catch {
    return { ireland: true, usa: false, australia: false };
  }
}

function parseStakingMode(marketFilter: string | null | undefined): "equal" | "weighted" {
  try {
    const parsed = JSON.parse(marketFilter ?? "{}") as { stakingMode?: string };
    return parsed.stakingMode === "weighted" ? "weighted" : "equal";
  } catch {
    return "equal";
  }
}

function parseBreakEvenOdds(marketFilter: string | null | undefined): number {
  try {
    const parsed = JSON.parse(marketFilter ?? "{}") as { breakEvenOdds?: number };
    return typeof parsed.breakEvenOdds === "number" ? parsed.breakEvenOdds : 13.0;
  } catch {
    return 13.0;
  }
}

function buildMarketFilter(
  existing: string | null | undefined,
  ireland: boolean,
  usa: boolean,
  australia: boolean,
  stakingMode: "equal" | "weighted",
  breakEvenOdds: number,
): string {
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(existing ?? "{}") as Record<string, unknown>; } catch { /* ignore */ }
  const codes = ["GB"];
  if (ireland) codes.push("IE");
  if (usa) codes.push("US");
  if (australia) codes.push("AU");
  parsed.countryCodes = codes;
  parsed.stakingMode = stakingMode;
  parsed.breakEvenOdds = breakEvenOdds;
  return JSON.stringify(parsed);
}

const BLANK_DEFAULTS = {
  name: "",
  description: "",
  eventTypeId: "7",
  betType: "BACK" as const,
  minOdds: 2.0,
  maxOdds: 10.0,
  stakeAmount: 5.0,
  maxStakeAmount: 50.0,
  aiModel: "grok-3-mini",
  aiPrompt:
    "Analyse this horse racing market. Back selections where you see clear value based on the odds, recent form and market movement. Only recommend a bet if you are confident. Reply with your recommendation and a brief reason.",
  marketFilter: "",
  includeIreland: true,
  includeUSA: false,
  includeAustralia: false,
  stakingMode: "equal" as "equal" | "weighted",
  breakEvenOdds: 13.0,
  isActive: true,
};

const formSchema = z
  .object({
    name: z.string().min(1, "Name is required").max(100),
    description: z.string().optional(),
    eventTypeId: z.string().min(1, "Select a sport"),
    betType: z.enum(["BACK", "LAY", "DUTCH"]),
    minOdds: z.coerce.number().min(1.01, "Min odds must be ≥ 1.01"),
    maxOdds: z.coerce.number().min(1.01, "Max odds must be ≥ 1.01"),
    stakeAmount: z.coerce.number().min(0.01, "Stake must be > 0"),
    maxStakeAmount: z.coerce.number().min(0.01, "Max stake must be > 0"),
    aiModel: z.string().min(1),
    aiPrompt: z.string().optional(),
    marketFilter: z.string().optional(),
    includeIreland: z.boolean(),
    includeUSA: z.boolean(),
    includeAustralia: z.boolean(),
    stakingMode: z.enum(["equal", "weighted"]),
    breakEvenOdds: z.coerce.number().min(1.5, "Must be ≥ 1.5").max(100, "Must be ≤ 100"),
    isActive: z.boolean(),
  })
  .refine((d) => d.maxOdds > d.minOdds, {
    message: "Max odds must be greater than min odds",
    path: ["maxOdds"],
  })
  .refine((d) => d.maxStakeAmount >= d.stakeAmount, {
    message: "Max stake must be ≥ stake amount",
    path: ["maxStakeAmount"],
  });

type FormValues = z.infer<typeof formSchema>;

interface StrategyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  strategy?: Strategy | null;
}

export function StrategyDialog({
  open,
  onOpenChange,
  strategy,
}: StrategyDialogProps) {
  const isEditing = !!strategy;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createStrategy = useCreateStrategy();
  const updateStrategy = useUpdateStrategy();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: BLANK_DEFAULTS,
  });

  useEffect(() => {
    if (open && strategy) {
      const cc = parseCountryCodes(strategy.marketFilter);
      form.reset({
        name: strategy.name,
        description: strategy.description ?? "",
        eventTypeId: strategy.eventTypeId,
        betType: strategy.betType as "BACK" | "LAY" | "DUTCH",
        minOdds: parseFloat(strategy.minOdds as unknown as string),
        maxOdds: parseFloat(strategy.maxOdds as unknown as string),
        stakeAmount: parseFloat(strategy.stakeAmount as unknown as string),
        maxStakeAmount: parseFloat(strategy.maxStakeAmount as unknown as string),
        aiModel: strategy.aiModel,
        aiPrompt: strategy.aiPrompt ?? "",
        marketFilter: strategy.marketFilter ?? "",
        includeIreland: cc.ireland,
        includeUSA: cc.usa,
        includeAustralia: cc.australia,
        stakingMode: parseStakingMode(strategy.marketFilter),
        breakEvenOdds: parseBreakEvenOdds(strategy.marketFilter),
        isActive: strategy.isActive,
      });
    } else if (open && !strategy) {
      form.reset(BLANK_DEFAULTS);
    }
  }, [open, strategy]);

  const onSubmit = (values: FormValues) => {
    const payload = {
      ...values,
      description: values.description || null,
      aiPrompt: values.aiPrompt || null,
      marketFilter: buildMarketFilter(values.marketFilter, values.includeIreland, values.includeUSA, values.includeAustralia, values.stakingMode, values.breakEvenOdds),
    };

    if (isEditing && strategy) {
      updateStrategy.mutate(
        { id: strategy.id, data: payload },
        {
          onSuccess: () => {
            toast({ title: "Strategy updated" });
            queryClient.invalidateQueries({
              queryKey: getListStrategiesQueryKey(),
            });
            onOpenChange(false);
          },
          onError: () => {
            toast({
              title: "Failed to update strategy",
              variant: "destructive",
            });
          },
        }
      );
    } else {
      createStrategy.mutate(
        { data: payload },
        {
          onSuccess: () => {
            toast({ title: "Strategy created" });
            queryClient.invalidateQueries({
              queryKey: getListStrategiesQueryKey(),
            });
            onOpenChange(false);
          },
          onError: () => {
            toast({
              title: "Failed to create strategy",
              variant: "destructive",
            });
          },
        }
      );
    }
  };

  const isPending = createStrategy.isPending || updateStrategy.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "Edit Strategy" : "New Strategy"}
          </DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            {/* Basic Info */}
            <div className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Strategy Name</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Horse Racing Value Backer" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description <span className="text-muted-foreground">(optional)</span></FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Brief description of this strategy..."
                        className="resize-none h-20"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="eventTypeId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Sport</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select sport" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {EVENT_TYPES.map((et) => (
                            <SelectItem key={et.id} value={et.id}>
                              {et.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="betType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Bet Type</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="BACK">BACK (single selection)</SelectItem>
                          <SelectItem value="LAY">LAY (bet against)</SelectItem>
                          <SelectItem value="DUTCH">DUTCH (back multiple to guarantee profit)</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* Racing Countries — only shown for Horse Racing or Greyhound */}
              {(form.watch("eventTypeId") === "7" || form.watch("eventTypeId") === "4339") && (
                <div className="space-y-2">
                  <p className="text-sm font-medium">Racing Countries</p>
                  <p className="text-xs text-muted-foreground">GB is always included. Tick to add additional countries.</p>
                  <div className="flex flex-wrap gap-4 pt-1">
                    <label className="flex items-center gap-2 cursor-pointer opacity-50 select-none">
                      <Checkbox checked={true} disabled />
                      <span className="text-sm">🇬🇧 Great Britain (always on)</span>
                    </label>
                    <FormField
                      control={form.control}
                      name="includeIreland"
                      render={({ field }) => (
                        <label className="flex items-center gap-2 cursor-pointer">
                          <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                          <span className="text-sm">🇮🇪 Ireland</span>
                        </label>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="includeUSA"
                      render={({ field }) => (
                        <label className="flex items-center gap-2 cursor-pointer">
                          <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                          <span className="text-sm">🇺🇸 USA</span>
                        </label>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="includeAustralia"
                      render={({ field }) => (
                        <label className="flex items-center gap-2 cursor-pointer">
                          <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                          <span className="text-sm">🇦🇺 Australia</span>
                        </label>
                      )}
                    />
                  </div>
                </div>
              )}
            </div>

            <Separator />

            {/* Odds & Stakes */}
            <div>
              <h3 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">Odds & Stakes</h3>
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="minOdds"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Min Odds</FormLabel>
                        <FormControl>
                          <Input type="number" step="0.01" min="1.01" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="maxOdds"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Max Odds</FormLabel>
                        <FormControl>
                          <Input type="number" step="0.01" min="1.01" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="stakeAmount"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          {form.watch("betType") === "DUTCH" ? "Total Dutch Stake (£)" : "Stake Per Bet (£)"}
                        </FormLabel>
                        <FormControl>
                          <Input type="number" step="0.01" min="0.01" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="maxStakeAmount"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Max Stake (£)</FormLabel>
                        <FormControl>
                          <Input type="number" step="0.01" min="0.01" {...field} />
                        </FormControl>
                        <FormDescription>Daily cap per strategy</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* Staking mode — DUTCH only */}
                {form.watch("betType") === "DUTCH" && (
                  <>
                    <FormField
                      control={form.control}
                      name="stakingMode"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Dutch Staking Mode</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="equal">Equal return — same profit whichever runner wins</SelectItem>
                              <SelectItem value="weighted">Gradient — maximum profit on favourite, decreasing to break-even at your chosen price</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormDescription>
                            {form.watch("stakingMode") === "weighted"
                              ? "Stakes follow odds^-n weighting. Every covered runner profits when it wins, with the favourite earning the most. Runners longer than the break-even price are not backed."
                              : "All backed runners return the same amount — guaranteed equal profit no matter who wins."}
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    {form.watch("stakingMode") === "weighted" && (
                      <FormField
                        control={form.control}
                        name="breakEvenOdds"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Break-even Price (decimal odds)</FormLabel>
                            <FormControl>
                              <Input type="number" step="0.5" min="1.5" max="100" {...field} />
                            </FormControl>
                            <FormDescription>
                              Runners at this price break even; shorter prices profit (favourite most), longer prices are not covered.
                              12/1 = 13.0 · 10/1 = 11.0 · 8/1 = 9.0 · 16/1 = 17.0
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    )}
                  </>
                )}
              </div>
            </div>

            <Separator />

            {/* AI Configuration */}
            <div>
              <h3 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">AI Configuration</h3>
              <div className="space-y-4">
                <FormField
                  control={form.control}
                  name="aiModel"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>AI Model</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {AI_MODELS.map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                              {m.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="aiPrompt"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>AI Prompt</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="Instructions for the AI when analysing markets..."
                          className="resize-none h-32 font-mono text-sm"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        The AI receives market data, runners, and odds alongside this prompt. Be specific about what you want it to look for.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>

            <Separator />

            {/* Status */}
            <FormField
              control={form.control}
              name="isActive"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between rounded-lg border border-border/50 p-4">
                  <div>
                    <FormLabel className="text-base">Active</FormLabel>
                    <FormDescription>
                      The bot will only use active strategies when scanning markets.
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending
                  ? isEditing
                    ? "Saving..."
                    : "Creating..."
                  : isEditing
                  ? "Save Changes"
                  : "Create Strategy"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
