import FS from 'fs';

export const TWEETS_MAPPING_FILE_NAME = 'tweets_mapping.json'; // store the imported tweets & bsky id mapping

export async function deleteBskyPosts(agent, tweets, minDate: Date, maxDate: Date){
// Delete bsky posts with a record in TWEETS_MAPPING_FILE_NAME.
// If something goes wrong, call this method to clear the previously imported posts.
// You may also use MIN_DATE and MAX_DATE to limit the range.

    try {
        for(let i=0; i < tweets.length; i++){
            const currentTweet =  tweets[i];
            const { tweet, bsky } = currentTweet;
            if(bsky){
              
                const tweetDate = new Date(tweet.created_at);
      
                if (minDate != undefined && tweetDate < minDate)
                    continue;
                if (maxDate != undefined && tweetDate > maxDate)
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
