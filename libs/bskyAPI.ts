import * as dotenv from 'dotenv';
import * as process from 'process';
import FS from 'fs';

dotenv.config();

export const TWEETS_MAPPING_FILE_NAME = 'tweets_mapping.json'; // store the imported tweets & bsky id mapping


let MIN_DATE: Date | undefined = undefined;
if (process.env.MIN_DATE != null && process.env.MIN_DATE.length > 0)
    MIN_DATE = new Date(process.env.MIN_DATE as string);

let MAX_DATE: Date | undefined = undefined;
if (process.env.MAX_DATE != null && process.env.MAX_DATE.length > 0)
    MAX_DATE = new Date(process.env.MAX_DATE as string);



export async function deleteBskyPosts(agent, tweets){
// Delete bsky posts with a record in TWEETS_MAPPING_FILE_NAME.
// If something goes wrong, call this method to clear the previously imported posts.
// You may also use MIN_DATE and MAX_DATE to limit the range.

    try {
        for(let i=0; i < tweets.length; i++){
            const currentTweet =  tweets[i];
            const { tweet, bsky } = currentTweet;
            if(bsky){
              
                const tweetDate = new Date(tweet.created_at);
      
                if (MIN_DATE != undefined && tweetDate < MIN_DATE)
                    continue;
                if (MAX_DATE != undefined && tweetDate > MAX_DATE)
                    continue;
                
                await agent.deletePost(bsky.uri);
                console.log(tweet.id)
                delete currentTweet.bsky;
            }
        }
    }catch(e){
        throw e;
    }finally{
        FS.writeFileSync(TWEETS_MAPPING_FILE_NAME, JSON.stringify(tweets, null, 4))
    }

}
