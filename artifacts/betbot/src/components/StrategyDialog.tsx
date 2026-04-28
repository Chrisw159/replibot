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
  { id: "gpt-4.1-mini", name: "GPT-4.1 Mini (fast, cheap)" },
  { id: "gpt-4.1", name: "GPT-4.1 (accurate)" },
  { id: "gpt-4o-mini", name: "GPT-4o Mini" },
  { id: "gpt-4o", name: "GPT-4o" },
];

const formSchema = z
  .object({
    name: z.string().min(1, "Name is required").max(100),
    description: z.string().optional(),
    eventTypeId: z.string().min(1, "Select a sport"),
    betType: z.enum(["BACK", "LAY"]),
    minOdds: z.coerce.number().min(1.01, "Min odds must be ≥ 1.01"),
    maxOdds: z.coerce.number().min(1.01, "Max odds must be ≥ 1.01"),
    stakeAmount: z.coerce.number().min(0.01, "Stake must be > 0"),
    maxStakeAmount: z.coerce.number().min(0.01, "Max stake must be > 0"),
    aiModel: z.string().min(1),
    aiPrompt: z.string().optional(),
    marketFilter: z.string().optional(),
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
    defaultValues: {
      name: "",
      description: "",
      eventTypeId: "7",
      betType: "BACK",
      minOdds: 2.0,
      maxOdds: 10.0,
      stakeAmount: 5.0,
      maxStakeAmount: 50.0,
      aiModel: "gpt-4.1-mini",
      aiPrompt:
        "Analyse this horse racing market. Back selections where you see clear value based on the odds, recent form and market movement. Only recommend a bet if you are confident. Reply with your recommendation and a brief reason.",
      marketFilter: "",
      isActive: true,
    },
  });

  useEffect(() => {
    if (open && strategy) {
      form.reset({
        name: strategy.name,
        description: strategy.description ?? "",
        eventTypeId: strategy.eventTypeId,
        betType: strategy.betType as "BACK" | "LAY",
        minOdds: parseFloat(strategy.minOdds as unknown as string),
        maxOdds: parseFloat(strategy.maxOdds as unknown as string),
        stakeAmount: parseFloat(strategy.stakeAmount as unknown as string),
        maxStakeAmount: parseFloat(
          strategy.maxStakeAmount as unknown as string
        ),
        aiModel: strategy.aiModel,
        aiPrompt: strategy.aiPrompt ?? "",
        marketFilter: strategy.marketFilter ?? "",
        isActive: strategy.isActive,
      });
    } else if (open && !strategy) {
      form.reset();
    }
  }, [open, strategy]);

  const onSubmit = (values: FormValues) => {
    const payload = {
      ...values,
      description: values.description || null,
      aiPrompt: values.aiPrompt || null,
      marketFilter: values.marketFilter || null,
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
                          <SelectItem value="BACK">BACK (bet for)</SelectItem>
                          <SelectItem value="LAY">LAY (bet against)</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>

            <Separator />

            {/* Odds & Stakes */}
            <div>
              <h3 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wide">Odds & Stakes</h3>
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
                      <FormLabel>Stake Per Bet (£)</FormLabel>
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
