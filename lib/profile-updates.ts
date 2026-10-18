export type ProfileUpdate = { display_name?: string; avatar_url?: string }
type Subscription = { userId: string; receive: (update: ProfileUpdate) => void }
const subscriptions = new Set<Subscription>()

export function listenForProfileUpdates(userId: string, receive: Subscription['receive']): () => void {
    const subscription = { userId, receive }
    subscriptions.add(subscription)
    return () => { subscriptions.delete(subscription) }
}

export function notifyProfileUpdated(userId: string, update: ProfileUpdate): void {
    for (const subscription of subscriptions) {
        if (subscription.userId === userId) subscription.receive(update)
    }
}
