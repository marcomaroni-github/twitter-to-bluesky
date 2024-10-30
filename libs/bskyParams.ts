import * as dotenv from 'dotenv';
import * as process from 'process';

import { checkPastHandles } from './urlHandler';

dotenv.config();

export const PAST_HANDLES = process.env.PAST_HANDLES!.split(",");

export function getReplyRefs({in_reply_to_screen_name, in_reply_to_status_id}, tweets):{
    "root": {
        "uri": string;
        "cid": string;
    },
    "parent": {
        "uri":string;
        "cid":string;
    },
}|null{
    const importReplyScreenNames = PAST_HANDLES || [];
    if(importReplyScreenNames.every(handle => in_reply_to_screen_name != handle)){
        console.log(`Skip Reply (wrong reply screen name :${in_reply_to_screen_name})`, importReplyScreenNames);
        return null;
    }

    const parent = tweets.find(({tweet}) => tweet.id == in_reply_to_status_id);

    let root = parent;
    while(root?.tweet?.in_reply_to_status_id){
        root = tweets.find(({tweet}) => tweet.id == root.tweet.in_reply_to_status_id)
    }
    
    if( !parent || !root || !parent.bsky || !root.bsky ){
        return null;
    }
    
    return {
        "root": {
            "uri": root.bsky["uri"],
            "cid": root.bsky["cid"],
        },
        "parent": {
            "uri": parent.bsky["uri"],
            "cid": parent.bsky["cid"],
        },
    }
}


export function getEmbeddedUrlAndRecord(
    urls: Array<{expanded_url: string}>, 
    tweets: Array<{
        tweet: Record<string, string>,
        bsky?: Record<string, string>,
    }>
): {
    embeddedUrl: string|null;
    embeddedRecord:{
        "uri": string;
        "cid": string;
    }|null;
}{
    let embeddedTweetUrl : string|null = null;
    const nullResult =   {
        embeddedUrl: null,
        embeddedRecord: null,
    };

    // get the last one url to embed
    const reversedUrls = urls.reverse(); 
    embeddedTweetUrl = reversedUrls.find(({expanded_url})=> checkPastHandles(expanded_url))?.expanded_url ?? null;
    
    if(!embeddedTweetUrl){
        return nullResult;
    }
    
    const index = embeddedTweetUrl.lastIndexOf("/");
    if(index == -1){
        return nullResult;
    }

    const urlId = embeddedTweetUrl.substring(index + 1);
    const tweet = tweets.find(({tweet: {id}}) => id == urlId)
    
    if(!tweet?.bsky){
        return nullResult;
    }

    return {
        embeddedUrl: embeddedTweetUrl,
        embeddedRecord: {
            "uri": tweet.bsky.uri,
            "cid": tweet.bsky.cid,
          }
    };
}


export function getMergeEmbed(images:[] = [], embeddedVideo:{}|null = null, record: {}|null = null): {}|null{
    let mediaData :{}|null = null;
    if(images.length > 0 ){

        mediaData = { 
          $type: "app.bsky.embed.images", 
          images 
        };
    } else if ( embeddedVideo != null ) {
        mediaData = embeddedVideo;
    }
   
    let recordData :{}|null = null;
    if(record && Object.keys(record).length > 0) {
        recordData = {
            $type: "app.bsky.embed.record",
            record
        };
    }
    
    if(mediaData && recordData){
      return {
        $type: "app.bsky.embed.recordWithMedia",
        media: mediaData,
        record: {
            record // Yes, we should use `record` instead of `recordData`. Because the api params should be like { record: { uri: string, cid: string  } }
        }
      };
    } 

    return mediaData || recordData;
      
}

