import * as dotenv from 'dotenv';
import * as process from 'process';

dotenv.config();

export const PAST_HANDLES = process.env.PAST_HANDLES!.split(",");

export function checkPastHandles(url: string): boolean{
    return (PAST_HANDLES || []).some(handle => 
        url.startsWith(`https://x.com/${handle}/`) || 
        url.startsWith(`https://twitter.com/${handle}/`)
    )
}

export function convertToBskyPostUrl(
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
    return getBskyPostUrl(tweet.bsky.uri);
}

export function getBskyPostUrl(bskyUri: string): string {
    const i = bskyUri.lastIndexOf("/");
    if(i == -1){
        return bskyUri;
    }
    const rkey = bskyUri.substring(i + 1);
    return `https://bsky.app/profile/${process.env.BLUESKY_USERNAME!}/post/${rkey}`;
}


