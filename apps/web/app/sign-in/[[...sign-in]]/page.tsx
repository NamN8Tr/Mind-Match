import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <div className="row" style={{ justifyContent: "center", paddingTop: 40 }}>
      <SignIn />
    </div>
  );
}
