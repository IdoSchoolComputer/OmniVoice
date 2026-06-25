import React, { useState } from 'react';
import axios from 'axios';
import { Button } from '@/components/ui/button';
import { Upload } from 'lucide-react';
import { toast } from 'sonner';

export default function Synthesize() {
  const [refFile, setRefFile] = useState<File | null>(null);
  const [texts, setTexts] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleFile = (f: File | null) => setRefFile(f);

  const submit = async () => {
    if (!texts.trim()) return toast.error('Provide one or more sentences');
    setIsLoading(true);
    try {
      const form = new FormData();
      form.append('texts', texts);
      if (refFile) form.append('ref_audio', refFile);
      const resp = await axios.post('/api/synthesize', form);
      const files = resp.data?.files;
      if (!Array.isArray(files) || files.length === 0) {
        throw new Error('No output files returned from synthesis');
      }

      files.forEach((file: { name: string; url: string }) => {
        const a = document.createElement('a');
        a.href = file.url;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      });

      toast.success(`Synthesis complete — downloaded ${files.length} file(s)`);
    } catch (err: any) {
      console.error("[Synthesize] Error:", err);
      console.error("[Synthesize] Response status:", err?.response?.status);

      let responseData = err?.response?.data;
      if (responseData instanceof Blob && typeof responseData.text === 'function') {
        try {
          const text = await responseData.text();
          console.error("[Synthesize] Response text:", text);
          responseData = text;
          try {
            responseData = JSON.parse(text);
          } catch {
            // keep raw text if JSON parse fails
          }
        } catch (parseErr) {
          console.error("[Synthesize] Failed to read error blob:", parseErr);
        }
      }

      console.error("[Synthesize] Response data:", responseData);
      const errorMsg =
        responseData?.error ||
        responseData?.details ||
        (typeof responseData === 'string' ? responseData : undefined) ||
        err.message ||
        'Synthesis failed';
      toast.error(errorMsg);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-4">Voice Cloning Synthesize</h1>
      <div className="mb-4">
        <label className="block mb-2">Reference audio (optional)</label>
        <input type="file" accept="audio/*" onChange={(e) => handleFile(e.target.files?.[0] ?? null)} />
      </div>
      <div className="mb-4">
        <label className="block mb-2">Sentences (one per line)</label>
        <textarea rows={6} className="w-full p-2 border rounded" value={texts} onChange={(e) => setTexts(e.target.value)} />
      </div>
      <div className="flex gap-2">
        <Button onClick={submit} disabled={isLoading}>
          {isLoading ? 'Synthesizing...' : 'Synthesize'}
        </Button>
      </div>
    </div>
  );
}
