import { zodResolver } from '@hookform/resolvers/zod';
import { loginRequestSchema, type LoginRequest } from '@health/contracts';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useNavigate, type Location } from 'react-router';

import { Alert } from '../components/Alert.js';
import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { loginWithPassword } from '../features/auth/actions.js';
import { ApiError } from '../lib/api-client.js';

export function Component() {
  const navigate = useNavigate();
  const location = useLocation() as Location<{ from?: Location } | undefined>;
  const [formError, setFormError] = useState<string | undefined>();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginRequest>({ resolver: zodResolver(loginRequestSchema) });

  const onSubmit = handleSubmit(async (data) => {
    setFormError(undefined);
    try {
      await loginWithPassword(data);
      const redirectTo = location.state?.from?.pathname ?? '/';
      await navigate(redirectTo, { replace: true });
    } catch (error) {
      setFormError(
        error instanceof ApiError ? error.message : 'Could not sign in. Please try again.',
      );
    }
  });

  return (
    <div className="mx-auto max-w-sm">
      <h1 className="mb-6 text-2xl font-semibold text-slate-900">Sign in</h1>
      <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
        {formError && <Alert variant="error">{formError}</Alert>}
        <Input
          label="Email"
          type="email"
          autoComplete="email"
          error={errors.email?.message}
          {...register('email')}
        />
        <Input
          label="Password"
          type="password"
          autoComplete="current-password"
          error={errors.password?.message}
          {...register('password')}
        />
        <Button type="submit" isLoading={isSubmitting}>
          Sign in
        </Button>
      </form>
      <p className="mt-4 text-sm text-slate-600">
        New here?{' '}
        <Link to="/register" className="font-medium text-brand-700 hover:underline">
          Create an account
        </Link>
      </p>
    </div>
  );
}
