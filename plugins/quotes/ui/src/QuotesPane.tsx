import { useState } from 'react';
import { definePane } from '@gestalts/sdk';
import { Practice } from './Practice';
import { Quotes } from './Quotes';

/** Practice the quotes, or manage them. */
export const QuotesPane = definePane({
  title: 'Quotes',
  Component: () => {
    const [tab, setTab] = useState<'practice' | 'manage'>('practice');
    return (
      <div className="flex h-full flex-col">
        <div role="tablist" className="tabs tabs-border justify-center">
          <button type="button" role="tab" className={`tab ${tab === 'practice' ? 'tab-active' : ''}`} onClick={() => setTab('practice')}>Practice</button>
          <button type="button" role="tab" className={`tab ${tab === 'manage' ? 'tab-active' : ''}`} onClick={() => setTab('manage')}>Quotes</button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
          {tab === 'practice' ? <Practice onManage={() => setTab('manage')} /> : <Quotes />}
        </div>
      </div>
    );
  },
});
