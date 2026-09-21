import React from 'react';

export default function TableWidget({ table }) {
  if (!table || table.rows.length === 0) {
    return <div className="widget-empty">Sin datos para mostrar.</div>;
  }
  return (
    <div className="widget-table-scroll">
      <table className="table">
        <thead>
          <tr>{table.columns.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {table.rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => <td key={j}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
