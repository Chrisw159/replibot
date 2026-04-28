import { useListBets } from "@workspace/api-client-react";
import { formatCurrency, formatNumber, formatDate } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function Bets() {
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const { data: bets, isLoading } = useListBets({ 
    status: statusFilter === "ALL" ? undefined : statusFilter,
    limit: 50 
  });

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'WON': return 'bg-chart-1/20 text-chart-1 border-chart-1/30';
      case 'LOST': return 'bg-chart-4/20 text-chart-4 border-chart-4/30';
      case 'PLACED': return 'bg-chart-3/20 text-chart-3 border-chart-3/30';
      case 'MATCHED': return 'bg-chart-2/20 text-chart-2 border-chart-2/30';
      case 'CANCELLED': return 'bg-muted text-muted-foreground border-border';
      default: return 'bg-muted text-muted-foreground border-border';
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <h1 className="text-3xl font-bold tracking-tight">Bet History</h1>
        <div className="w-48">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="bg-card border-border/50">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Statuses</SelectItem>
              <SelectItem value="WON">Won</SelectItem>
              <SelectItem value="LOST">Lost</SelectItem>
              <SelectItem value="MATCHED">Matched</SelectItem>
              <SelectItem value="PLACED">Placed</SelectItem>
              <SelectItem value="CANCELLED">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card className="border-border/50 bg-card/50 overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow className="border-border/50 hover:bg-transparent">
                <TableHead>Time</TableHead>
                <TableHead>Market & Selection</TableHead>
                <TableHead>Strategy</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Odds</TableHead>
                <TableHead className="text-right">Stake</TableHead>
                <TableHead className="text-right">P&L</TableHead>
                <TableHead className="text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array(10).fill(0).map((_, i) => (
                  <TableRow key={i} className="border-border/50">
                    <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-48" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                    <TableCell className="text-right"><Skeleton className="h-4 w-12 ml-auto" /></TableCell>
                    <TableCell className="text-right"><Skeleton className="h-4 w-16 ml-auto" /></TableCell>
                    <TableCell className="text-right"><Skeleton className="h-4 w-16 ml-auto" /></TableCell>
                    <TableCell className="text-right"><Skeleton className="h-6 w-20 ml-auto rounded-full" /></TableCell>
                  </TableRow>
                ))
              ) : bets?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-12 text-muted-foreground">
                    No bets found
                  </TableCell>
                </TableRow>
              ) : bets?.map(bet => (
                <TableRow key={bet.id} className="border-border/50 hover:bg-muted/30">
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                    {formatDate(bet.placedAt)}
                  </TableCell>
                  <TableCell>
                    <div className="font-medium text-sm">{bet.selectionName}</div>
                    <div className="text-xs text-muted-foreground">{bet.eventName}</div>
                  </TableCell>
                  <TableCell className="text-sm">{bet.strategyName || 'Manual'}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={`font-mono text-xs ${bet.betType === 'BACK' ? 'text-chart-3 border-chart-3/30' : 'text-chart-5 border-chart-5/30'}`}>
                      {bet.betType}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {formatNumber(bet.matchedOdds || bet.requestedOdds)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {formatCurrency(bet.stakeAmount)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {bet.status === 'WON' || bet.status === 'LOST' ? (
                      <span className={bet.actualProfit && bet.actualProfit > 0 ? 'text-chart-1' : 'text-chart-4'}>
                        {bet.actualProfit && bet.actualProfit > 0 ? '+' : ''}{formatCurrency(bet.actualProfit)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        ~{formatCurrency(bet.potentialProfit)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge variant="outline" className={getStatusColor(bet.status)}>
                      {bet.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}
