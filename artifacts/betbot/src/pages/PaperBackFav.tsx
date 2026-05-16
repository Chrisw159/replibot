import PaperStrategy from "./PaperStrategy";

export default function PaperBackFav() {
  return (
    <PaperStrategy
      slug="back-fav"
      title="Paper Back Favourite"
      subtitle="BACK the BSP favourite when its pre-off back price sits in [1.80, 3.50)"
      description="BACK the favourite at BSP when its pre-off back price is between 1.80 and 3.50. Backtest over 8 days returned +19.8% ROI (+£398 on £2,010 staked)."
    />
  );
}
