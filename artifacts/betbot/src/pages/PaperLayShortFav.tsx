import PaperStrategy from "./PaperStrategy";

export default function PaperLayShortFav() {
  return (
    <PaperStrategy
      slug="lay-short-fav"
      title="Paper Lay Short Favourite"
      subtitle="LAY the BSP favourite when its pre-off back price is under 1.80"
      description="LAY the favourite at BSP when its pre-off back price is below 1.80. Backtest over 33 races returned +7.8% ROI — short-priced favourites under-perform their implied probability."
    />
  );
}
