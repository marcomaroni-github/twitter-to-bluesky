import * as dotenv from 'dotenv';
import * as process from 'process';

dotenv.config();

export const IMPORT_REPLY_USER_ID = process.env.IMPORT_REPLY_USER_ID;


export function getReplyRefs({in_reply_to_user_id, in_reply_to_status_id}, tweets):{
    "root": {
        "uri": string;
        "cid": string;
    },
    "parent": {
        "uri":string;
        "cid":string;
    },
}|null{
    if(in_reply_to_user_id != IMPORT_REPLY_USER_ID){
        console.log(`Skip Reply (wrong reply user_id :${IMPORT_REPLY_USER_ID}:${in_reply_to_user_id})`);
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
