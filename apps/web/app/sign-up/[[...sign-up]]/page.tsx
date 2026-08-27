import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return (
    <div className="row" style={{ justifyContent: "center", paddingTop: 40 }}>
      <SignUp />
    </div>
  );
}
