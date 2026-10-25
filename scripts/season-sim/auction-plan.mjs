export function plannedAuctionBid(purchased,budget=20,activeSlots=3){
  return purchased+1===activeSlots?budget-purchased:1
}
