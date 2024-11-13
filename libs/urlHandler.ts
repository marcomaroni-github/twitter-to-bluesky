
export function checkPastHandles(twitterHandles: string[], url: string): boolean{
    return (twitterHandles || []).some(handle => 
        url.startsWith(`https://x.com/${handle}/`) || 
        url.startsWith(`https://twitter.com/${handle}/`)
    )
}

export function convertToBskyPostUrl(
    blueskyUsername: string,
    tweetUrl:string , 
    tweets: Array<{
            tweet: Record<string, string>,
            bsky?: Record<string, string>,
        }>
): string {
    const index = tweetUrl.lastIndexOf("/");
    if(index == -1){
        return tweetUrl;
    }

    const urlId = tweetUrl.substring(index + 1);
    const tweet = tweets.find(({tweet: {id}}) => id == urlId);
    if(!tweet?.bsky){
        return tweetUrl;
    }
    return getBskyPostUrl(blueskyUsername, tweet.bsky.uri);
}

export function getBskyPostUrl(blueskyUsername : string, bskyUri: string): string {
    const i = bskyUri.lastIndexOf("/");
    if(i == -1){
        return bskyUri;
    }
    const rkey = bskyUri.substring(i + 1);
    return `https://bsky.app/profile/${blueskyUsername!}/post/${rkey}`;
}


