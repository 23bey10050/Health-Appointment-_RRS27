import { useState } from 'react';
import { Link } from 'react-router';

import { Alert } from '../../components/Alert.js';
import { ColdStartNotice } from '../../components/ColdStartNotice.js';
import { Input } from '../../components/Input.js';
import { useDoctors } from '../../features/doctors/queries.js';

export function Component() {
  const [specialization, setSpecialization] = useState('');
  const { data, isLoading, isError } = useDoctors(
    specialization.trim() ? { specialization: specialization.trim() } : {},
  );

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold text-slate-900">Find a doctor</h1>

      <div className="mb-6 max-w-sm">
        <Input
          label="Specialization"
          placeholder="e.g. Cardiology"
          value={specialization}
          onChange={(event) => setSpecialization(event.target.value)}
        />
      </div>

      <ColdStartNotice isLoading={isLoading} />

      {isError && <Alert variant="error">Could not load the doctor list. Please try again.</Alert>}

      {!isLoading && data && data.items.length === 0 && (
        <p className="text-slate-600">No doctors match that search.</p>
      )}

      {data && data.items.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2">
          {data.items.map((doctor) => (
            <li key={doctor.id}>
              <Link
                to={`/doctors/${doctor.id}`}
                className="block rounded-md border border-slate-200 bg-white p-4 hover:border-brand-300 hover:shadow-sm"
              >
                <p className="font-medium text-slate-900">{doctor.fullName}</p>
                <p className="text-sm text-slate-600">{doctor.specialization}</p>
                {doctor.bio && <p className="mt-2 text-sm text-slate-500">{doctor.bio}</p>}
                {doctor.consultationFee !== null && (
                  <p className="mt-2 text-sm font-medium text-slate-700">
                    ₹{doctor.consultationFee}
                  </p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
