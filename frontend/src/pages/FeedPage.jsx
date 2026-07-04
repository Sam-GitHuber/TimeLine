import { useOutletContext } from "react-router-dom";
import ComposeBox from "../components/ComposeBox.jsx";
import PostCard from "../components/PostCard.jsx";

// The home timeline: everyone's posts, strictly newest-first. No ranking, no
// "suggested" content — that constraint is the whole point of the project.
export default function FeedPage() {
  const { posts, addPost, currentUser } = useOutletContext();

  // Sort a copy by createdAt, descending. We never mutate the source array.
  const sorted = [...posts].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );

  return (
    <div>
      <ComposeBox currentUser={currentUser} onPost={addPost} />
      <div>
        {sorted.map((post) => (
          <PostCard key={post.id} post={post} />
        ))}
      </div>
    </div>
  );
}
