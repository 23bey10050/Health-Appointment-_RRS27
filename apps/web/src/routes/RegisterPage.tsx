import { zodResolver } from '@hookform/resolvers/zod';
import { registerRequestSchema, type RegisterRequest } from '@health/contracts';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router';

import { Alert } from '../components/Alert.js';
import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { registerPatient } from '../features/auth/actions.js';
import { ApiError } from '../lib/api-client.js';
import { browserTimezone } from '../lib/format.js';

/**
 * Signing up here always creates a patient account, no matter what this form could be made to
 * send - the API itself ignores anything else, and the form does not even offer the choice, so
 * there is nothing here that could quietly disagree with that rule later.
 */
export function Component() {
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | undefined>();

  const {
    register: registerField,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RegisterRequest>({ resolver: zodResolver(registerRequestSchema) });

  const onSubmit = handleSubmit(async (data) => {
    setFormError(undefined);
    try {
      await registerPatient({ ...data, timezone: data.timezone ?? browserTimezone() });
      await navigate('/', { replace: true });
    } catch (error) {
      setFormError(
        error instanceof ApiError
          ? error.message
          : 'Could not create your account. Please try again.',
      );
    }
  });

  return (
    <div className="mx-auto max-w-sm">
      <h1 className="mb-6 text-2xl font-semibold text-slate-900">Create your account</h1>
      <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
        {formError && <Alert variant="error">{formError}</Alert>}
        <Input
          label="Full name"
          autoComplete="name"
          error={errors.fullName?.message}
          {...registerField('fullName')}
        />
        <Input
          label="Email"
          type="email"
          autoComplete="email"
          error={errors.email?.message}
          {...registerField('email')}
        />
        <Input
          label="Password"
          type="password"
          autoComplete="new-password"
          error={errors.password?.message}
          {...registerField('password')}
        />
        <p className="-mt-2 text-xs text-slate-500">
          At least 10 characters. A long passphrase works better than a short one with symbols
          forced into it.
        </p>
        <Button type="submit" isLoading={isSubmitting}>
          Create account
        </Button>
      </form>
      <p className="mt-4 text-sm text-slate-600">
        Already have an account?{' '}
        <Link to="/login" className="font-medium text-brand-700 hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
