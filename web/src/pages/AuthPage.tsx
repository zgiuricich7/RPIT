import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useLogin, useRegister } from "../api/hooks.ts";

export function AuthPage({ mode }: { mode: "login" | "register" }) {
  const login = useLogin();
  const register = useRegister();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const m = mode === "login" ? login : register;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (mode === "login") login.mutate({ email, password });
    else register.mutate({ name, email, password });
  }

  return (
    <div className="auth">
      <form onSubmit={submit}>
        <h1>{mode === "login" ? "Sign in to Tasktree" : "Create your account"}</h1>
        {mode === "register" && (
          <label className="field">
            Name
            <input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
        )}
        <label className="field">
          Email
          <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field">
          Password
          <input
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={mode === "register" ? 8 : undefined}
            required
          />
        </label>
        {m.error && <div className="form-error">{m.error.message}</div>}
        <button className="btn primary" disabled={m.isPending}>
          {mode === "login" ? "Sign in" : "Create account"}
        </button>
        <div className="muted">
          {mode === "login" ? (
            <>
              New here? <Link to="/register">Create an account</Link>
            </>
          ) : (
            <>
              Already have an account? <Link to="/login">Sign in</Link>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
